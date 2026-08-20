import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { AudienceFilter, Campaign, VariableSource } from '@/types/campaigns';
import type { Contact } from '@/types/db';

interface CreateCampaignInput {
  name: string;
  template_id: string;
  audience_filter: AudienceFilter;
  variable_mapping: Record<string, VariableSource>;
  scheduled_at: string | null; // ISO; null = start immediately
  // Número (canal Zernio) que dispara o broadcast; null = default da org.
  channel_id: string | null;
}

interface UseCampaignsResult {
  campaigns: Campaign[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createAndQueue: (
    input: CreateCampaignInput,
  ) => Promise<{ campaign: Campaign; queued: number } | null>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  previewAudience: (filter: AudienceFilter) => Promise<number>;
}

async function resolveAudienceIds(filter: AudienceFilter): Promise<string[]> {
  const supabase = getSupabase();

  const hasTags = Array.isArray(filter.tag_ids) && filter.tag_ids.length > 0;
  const cfEntries = Object.entries(filter.custom_fields ?? {}).filter(
    ([k, v]) => k.trim() && v.trim(),
  );
  const hasCustom = cfEntries.length > 0;
  const hasPipeline = typeof filter.pipeline_id === 'string' && filter.pipeline_id.length > 0;
  const hasStages = Array.isArray(filter.stage_ids) && filter.stage_ids.length > 0;
  const hasDeals = hasPipeline || hasStages;

  // SEGURANÇA: só dispara para TODA a base quando o filtro é explicitamente
  // `{ all: true }`. Um filtro de tags/custom/funil vazio (ex.: modo "tags"
  // selecionado mas nenhuma tag marcada) resolve para ZERO — nunca para todos
  // — para evitar disparo em massa acidental contra a base inteira.
  if (!filter.all && !hasTags && !hasCustom && !hasDeals) return [];

  // Interseção (AND) entre conjuntos de candidatos; null = "sem restrição ainda".
  const intersect = (a: string[] | null, b: string[]): string[] =>
    a === null ? b : a.filter((id) => new Set(b).has(id));

  // Start with the set of contact IDs matching tag filters, if any.
  let candidateIds: string[] | null = null;
  if (hasTags) {
    const { data: links } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', filter.tag_ids as string[]);
    candidateIds = Array.from(
      new Set(((links ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id)),
    );
    if (candidateIds.length === 0) return [];
  }

  // Restringe pelos contatos que têm ao menos um deal no funil/etapas escolhidos.
  // Filtrar por stage_id já implica o funil; sem etapas, considera o funil todo.
  if (hasDeals) {
    let dealsQuery = supabase.schema('whatsapp_hub').from('deals').select('contact_id');
    if (hasStages) dealsQuery = dealsQuery.in('stage_id', filter.stage_ids as string[]);
    else if (hasPipeline) dealsQuery = dealsQuery.eq('pipeline_id', filter.pipeline_id as string);
    const { data: dealRows, error: dealsErr } = await dealsQuery;
    if (dealsErr) throw new Error(dealsErr.message);
    const dealContactIds = Array.from(
      new Set(((dealRows ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id)),
    );
    if (dealContactIds.length === 0) return [];
    candidateIds = intersect(candidateIds, dealContactIds);
    if (candidateIds.length === 0) return [];
  }

  let query = supabase.schema('whatsapp_hub').from('contacts').select('id, custom_fields');
  if (candidateIds) query = query.in('id', candidateIds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Pick<Contact, 'id' | 'custom_fields'>>;

  // Apply custom-field filter in JS (Postgrest JSON filters would work too
  // but stay simple for now — audiences are small).
  const filtered = !hasCustom
    ? rows
    : rows.filter((r) => {
        const fields = r.custom_fields ?? {};
        return cfEntries.every(([k, v]) => String(fields[k] ?? '') === v);
      });

  return filtered.map((r) => r.id);
}

export function useCampaigns(): UseCampaignsResult {
  const { userId } = useAppUser();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    else setCampaigns((data ?? []) as Campaign[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Subscribes to live campaign-row changes so the list stays fresh while
  // dispatch-campaign bumps counters in the background. Channel name is
  // randomized per mount because React StrictMode double-mounts effects —
  // Supabase rejects adding listeners to a channel whose subscription is
  // still being torn down from the first invocation.
  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    const channelName = `campaigns:${Math.random().toString(36).slice(2, 10)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'whatsapp_hub',
          table: 'campaigns',
        },
        () => {
          void reload();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, reload]);

  const previewAudience = async (filter: AudienceFilter): Promise<number> => {
    if (!userId) return 0;
    const ids = await resolveAudienceIds(filter);
    return ids.length;
  };

  const createAndQueue: UseCampaignsResult['createAndQueue'] = async (input) => {
    if (!userId) return null;
    const supabase = getSupabase();

    const contactIds = await resolveAudienceIds(input.audience_filter);
    if (contactIds.length === 0) {
      throw new Error('Nenhum contato corresponde aos filtros da audiência.');
    }

    const { data: campaign, error: err } = await supabase
      .from('campaigns')
      .insert({
        name: input.name,
        template_id: input.template_id,
        channel_id: input.channel_id,
        status: input.scheduled_at ? 'scheduled' : 'sending',
        scheduled_at: input.scheduled_at,
        audience_filter: input.audience_filter,
        variable_mapping: input.variable_mapping,
        total_contacts: contactIds.length,
        started_at: input.scheduled_at ? null : new Date().toISOString(),
      })
      .select()
      .single();
    if (err || !campaign) {
      throw new Error(err?.message ?? 'Falha ao criar campanha');
    }
    const created = campaign as Campaign;

    // Materialize the queue. Chunk to be friendly to PostgREST payload limits.
    const CHUNK = 500;
    for (let i = 0; i < contactIds.length; i += CHUNK) {
      const chunk = contactIds.slice(i, i + CHUNK);
      const { error: insErr } = await supabase.schema('whatsapp_hub').from('campaign_contacts').insert(
        chunk.map((contact_id) => ({
          campaign_id: created.id,
          contact_id,
          status: 'pending' as const,
        })),
      );
      if (insErr) throw new Error(insErr.message);
    }

    await reload();
    return { campaign: created, queued: contactIds.length };
  };

  const pause: UseCampaignsResult['pause'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('campaigns')
      .update({ status: 'paused' })
      .eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const resume: UseCampaignsResult['resume'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('campaigns')
      .update({ status: 'sending' })
      .eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const remove: UseCampaignsResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('campaigns').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return {
    campaigns,
    loading,
    error,
    reload,
    createAndQueue,
    pause,
    resume,
    remove,
    previewAudience,
  };
}

// Maps the most common Postgres/PostgREST errors to actionable pt-BR messages.
function translateDbError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('duplicate key')) return 'Registro duplicado — verifique os dados informados.';
  if (lower.includes('row-level security') || lower.includes('permission denied')) return 'Você não tem permissão para esta ação.';
  if (lower.includes('violates foreign key')) return 'Não é possível concluir: há registros vinculados.';
  if (lower.includes('violates check constraint') || lower.includes('invalid input')) return 'Dados inválidos — revise os campos e tente novamente.';
  return message || 'Não foi possível concluir a operação.';
}
