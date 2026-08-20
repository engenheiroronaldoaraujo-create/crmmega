import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import type { Pipeline, Stage, Deal, Tag } from '@/types/crm';

const DEAL_SELECT =
  '*, contact:contact_id(id, name, phone, email, custom_fields), deal_tags(tag:tag_id(id, name, color)), deal_products(product:product_id(id, name))';

// Resumo das conversas do contato (canal + última interação) para os filtros.
// Um contato pode ter várias conversas (Meta, UAZAPI, Instagram).
export type { ContactConvInfo } from '@/components/funil/funilFilterLogic';
import type { ContactConvInfo } from '@/components/funil/funilFilterLogic';

// Normaliza os deal_tags/deal_products aninhados do PostgREST em Deal.tags/products.
function normalizeDeal(row: Record<string, unknown>): Deal {
  const dt = (row.deal_tags as Array<{ tag: Tag | null }> | undefined) ?? [];
  const tags = dt.map((x) => x.tag).filter((t): t is Tag => Boolean(t));
  const dp = (row.deal_products as Array<{ product: { id: string; name: string } | null }> | undefined) ?? [];
  const products = dp.map((x) => x.product).filter((p): p is { id: string; name: string } => Boolean(p));
  const { deal_tags: _omit, deal_products: _omit2, ...rest } = row;
  return { ...(rest as unknown as Deal), tags, products };
}

interface CreateDealInput {
  title: string;
  contact_id: string;
  value?: number;
  stage_id: string;
}

interface UsePipelineResult {
  pipelines: Pipeline[];
  selectedId: string | null;
  select: (id: string) => void;
  pipeline: Pipeline | null;
  stages: Stage[];
  deals: Deal[];
  // dealId → due_at da próxima ação pendente (badge de relógio no card).
  nextActionByDeal: Record<string, string>;
  // contactId → conversas do contato (canal + última interação) p/ os filtros.
  convByContact: Record<string, ContactConvInfo[]>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  moveDeal: (dealId: string, stageId: string) => Promise<void>;
  createDeal: (input: CreateDealInput) => Promise<void>;
  archiveDeal: (dealId: string) => Promise<void>;
  unarchiveDeal: (dealId: string) => Promise<void>;
  // Gestão de funis
  createPipeline: (name: string) => Promise<Pipeline | null>;
  renamePipeline: (id: string, name: string) => Promise<void>;
  deletePipeline: (id: string) => Promise<{ ok: boolean; error?: string }>;
  setDefaultPipeline: (id: string) => Promise<void>;
  // Editor de estágios
  addStage: (name: string) => Promise<void>;
  renameStage: (id: string, name: string) => Promise<void>;
  setStageColor: (id: string, color: string | null) => Promise<void>;
  setStageProbability: (id: string, probability: number) => Promise<void>;
  setStageAiCriteria: (id: string, criteria: string | null) => Promise<void>;
  reorderStages: (orderedIds: string[]) => Promise<void>;
  removeStage: (id: string, moveToStageId: string) => Promise<{ ok: boolean; error?: string }>;
}

export function usePipeline(): UsePipelineResult {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [nextActionByDeal, setNextActionByDeal] = useState<Record<string, string>>({});
  const [convByContact, setConvByContact] = useState<Record<string, ContactConvInfo[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId],
  );

  // Carrega a lista de funis comerciais. Mantém a seleção atual se ainda existir,
  // senão cai no default (ou no primeiro).
  const loadPipelines = useCallback(async () => {
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('pipelines')
      .select('*')
      .eq('kind', 'comercial')
      .order('position');
    if (err) {
      setError(err.message);
      return [] as Pipeline[];
    }
    const list = (data ?? []) as Pipeline[];
    setPipelines(list);
    setSelectedId((cur) => {
      if (cur && list.some((p) => p.id === cur)) return cur;
      return (list.find((p) => p.is_default) ?? list[0])?.id ?? null;
    });
    return list;
  }, []);

  // Carrega estágios + deals do funil selecionado.
  const loadBoard = useCallback(async (pipelineId: string | null) => {
    if (!pipelineId) {
      setStages([]);
      setDeals([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const supabase = getSupabase();
    const [{ data: st }, { data: dl, error: dErr }] = await Promise.all([
      supabase.from('stages').select('*').eq('pipeline_id', pipelineId).order('position'),
      supabase.from('deals').select(DEAL_SELECT).eq('pipeline_id', pipelineId).order('created_at', { ascending: false }),
    ]);
    if (dErr) setError(dErr.message);
    setStages((st ?? []) as Stage[]);
    const dealList = ((dl ?? []) as Record<string, unknown>[]).map(normalizeDeal);
    setDeals(dealList);

    // Próxima ação pendente por deal (menor due_at) → badge de relógio no card.
    const ids = dealList.map((d) => d.id);
    if (ids.length > 0) {
      const { data: acts } = await supabase
        .from('crm_activities')
        .select('deal_id, due_at')
        .in('deal_id', ids)
        .eq('done', false)
        .not('due_at', 'is', null)
        .order('due_at', { ascending: true });
      const map: Record<string, string> = {};
      for (const a of (acts ?? []) as Array<{ deal_id: string | null; due_at: string }>) {
        if (a.deal_id && !map[a.deal_id]) map[a.deal_id] = a.due_at;
      }
      setNextActionByDeal(map);
    } else {
      setNextActionByDeal({});
    }

    // Canal + última interação da conversa de cada contato (filtros do funil).
    const contactIds = [...new Set(dealList.map((d) => d.contact_id))];
    if (contactIds.length > 0) {
      const { data: convs } = await supabase
        .from('conversations')
        .select('contact_id, channel, last_message_at, provider')
        .in('contact_id', contactIds);
      const cmap: Record<string, ContactConvInfo[]> = {};
      for (const c of (convs ?? []) as Array<{ contact_id: string; channel: string | null; last_message_at: string | null; provider: string | null }>) {
        (cmap[c.contact_id] ??= []).push({ channel: c.channel, last_message_at: c.last_message_at, provider: c.provider });
      }
      setConvByContact(cmap);
    } else {
      setConvByContact({});
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    const list = await loadPipelines();
    const target = (list.find((p) => p.id === selectedId) ?? list.find((p) => p.is_default) ?? list[0])?.id ?? null;
    await loadBoard(target);
  }, [loadPipelines, loadBoard, selectedId]);

  useEffect(() => {
    void loadPipelines().then((list) => {
      const target = (list.find((p) => p.is_default) ?? list[0])?.id ?? null;
      void loadBoard(target);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ao trocar de funil no seletor, recarrega o board.
  useEffect(() => {
    if (selectedId) void loadBoard(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const select = useCallback((id: string) => setSelectedId(id), []);

  // Realtime dos deals do funil ativo.
  useEffect(() => {
    if (!selectedId) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel(`pipeline-${selectedId}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'deals' }, (payload) => {
        setDeals((cur) => {
          if (payload.eventType === 'DELETE') return cur.filter((d) => d.id !== (payload.old as Deal).id);
          const row = payload.new as Deal;
          if (row.pipeline_id !== selectedId) return cur.filter((d) => d.id !== row.id);
          const idx = cur.findIndex((d) => d.id === row.id);
          if (idx === -1) return [{ ...row, tags: [], products: [] }, ...cur];
          const next = [...cur];
          next[idx] = { ...next[idx], ...row };
          return next;
        });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [selectedId]);

  const moveDeal = useCallback(
    async (dealId: string, stageId: string) => {
      const prevStageId = deals.find((d) => d.id === dealId)?.stage_id ?? null;
      const stage = stages.find((s) => s.id === stageId);
      const patch: Partial<Deal> = { stage_id: stageId };
      // Regra de negócio: ganho → cliente Morno; perdido → volta a Lead Frio
      // (sem badge de cliente).
      if (stage?.is_won) {
        patch.status = 'won';
        patch.temperature = 'Morno';
      } else if (stage?.is_lost) {
        patch.status = 'lost';
        patch.temperature = 'Frio';
        patch.lead_type = 'Lead';
      } else {
        patch.status = 'open';
      }
      setDeals((cur) => cur.map((d) => (d.id === dealId ? { ...d, ...patch } : d)));
      const supabase = getSupabase();
      const { error: err } = await supabase.from('deals').update(patch).eq('id', dealId);
      if (err) {
        setError(err.message);
        return;
      }
      // Registra a movimentação manual no histórico (Módulo 8: moved_by='humano').
      if (prevStageId !== stageId) {
        const { data: u } = await supabase.auth.getUser();
        await supabase.from('lead_stage_history').insert({
          deal_id: dealId,
          from_stage_id: prevStageId,
          to_stage_id: stageId,
          moved_by: 'humano',
          actor_id: u?.user?.id ?? null,
        });
      }
    },
    [stages, deals],
  );

  const createDeal = useCallback<UsePipelineResult['createDeal']>(
    async (input) => {
      if (!selectedId) return;
      const supabase = getSupabase();
      // Se a etapa inicial já é de ganho/perda, o deal nasce com o status e o
      // timestamp correspondentes (o trigger de won_at/lost_at só cobre UPDATE
      // de status, não INSERT) — senão o card fica na coluna Ganho sem contar
      // como venda no dashboard.
      const stage = stages.find((s) => s.id === input.stage_id);
      const nowISO = new Date().toISOString();
      const { data, error: err } = await supabase
        .from('deals')
        .insert({
          title: input.title,
          contact_id: input.contact_id,
          value: input.value ?? 0,
          pipeline_id: selectedId,
          stage_id: input.stage_id,
          status: stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open',
          ...(stage?.is_won ? { won_at: nowISO } : stage?.is_lost ? { lost_at: nowISO } : {}),
        })
        .select(DEAL_SELECT)
        .single();
      if (err) {
        setError(err.message);
        return;
      }
      const deal = normalizeDeal(data as Record<string, unknown>);
      setDeals((cur) => (cur.some((d) => d.id === deal.id) ? cur : [deal, ...cur]));
    },
    [selectedId, stages],
  );

  // Arquivar / restaurar: o deal sai do board (archived_at) sem ser excluído.
  const archiveDeal = useCallback(async (dealId: string) => {
    const ts = new Date().toISOString();
    setDeals((cur) => cur.map((d) => (d.id === dealId ? { ...d, archived_at: ts } : d)));
    const supabase = getSupabase();
    const { error: err } = await supabase.from('deals').update({ archived_at: ts }).eq('id', dealId);
    if (err) setError(err.message);
  }, []);

  const unarchiveDeal = useCallback(async (dealId: string) => {
    setDeals((cur) => cur.map((d) => (d.id === dealId ? { ...d, archived_at: null } : d)));
    const supabase = getSupabase();
    const { error: err } = await supabase.from('deals').update({ archived_at: null }).eq('id', dealId);
    if (err) setError(err.message);
  }, []);

  // ---- Gestão de funis ------------------------------------------------------
  const createPipeline = useCallback<UsePipelineResult['createPipeline']>(async (name) => {
    const supabase = getSupabase();
    const nextPos = pipelines.reduce((m, p) => Math.max(m, p.position), -1) + 1;
    const { data, error: err } = await supabase
      .from('pipelines')
      .insert({ name: name.trim(), kind: 'comercial', position: nextPos, is_default: false })
      .select('*')
      .single();
    if (err) {
      setError(err.message);
      return null;
    }
    const pipe = data as Pipeline;
    // Semeia estágios padrão para o funil não nascer vazio.
    await supabase.from('stages').insert([
      { pipeline_id: pipe.id, name: 'Novo lead', position: 0, is_won: false, is_lost: false, probability: 10 },
      { pipeline_id: pipe.id, name: 'Em andamento', position: 1, is_won: false, is_lost: false, probability: 50 },
      { pipeline_id: pipe.id, name: 'Ganho', position: 2, is_won: true, is_lost: false, probability: 100 },
      { pipeline_id: pipe.id, name: 'Perdido', position: 3, is_won: false, is_lost: true, probability: 0 },
    ]);
    await loadPipelines();
    setSelectedId(pipe.id);
    return pipe;
  }, [pipelines, loadPipelines]);

  const renamePipeline = useCallback(async (id: string, name: string) => {
    const supabase = getSupabase();
    setPipelines((cur) => cur.map((p) => (p.id === id ? { ...p, name } : p)));
    const { error: err } = await supabase.from('pipelines').update({ name: name.trim() }).eq('id', id);
    if (err) setError(err.message);
  }, []);

  const deletePipeline = useCallback<UsePipelineResult['deletePipeline']>(
    async (id) => {
      if (pipelines.length <= 1) return { ok: false, error: 'Não é possível excluir o único funil.' };
      const supabase = getSupabase();
      const { count } = await supabase
        .from('deals')
        .select('id', { count: 'exact', head: true })
        .eq('pipeline_id', id);
      if ((count ?? 0) > 0) {
        return { ok: false, error: 'Este funil tem negócios. Mova-os para outro funil antes de excluir.' };
      }
      const { error: err } = await supabase.from('pipelines').delete().eq('id', id);
      if (err) return { ok: false, error: err.message };
      if (selectedId === id) setSelectedId(null);
      await loadPipelines();
      return { ok: true };
    },
    [pipelines, selectedId, loadPipelines],
  );

  const setDefaultPipeline = useCallback(async (id: string) => {
    const supabase = getSupabase();
    setPipelines((cur) => cur.map((p) => ({ ...p, is_default: p.id === id })));
    await supabase.from('pipelines').update({ is_default: false }).neq('id', id);
    await supabase.from('pipelines').update({ is_default: true }).eq('id', id);
  }, []);

  // ---- Editor de estágios ---------------------------------------------------
  const addStage = useCallback(async (name: string) => {
    if (!selectedId) return;
    const supabase = getSupabase();
    const nextPos = stages.reduce((m, s) => Math.max(m, s.position), -1) + 1;
    const { data, error: err } = await supabase
      .from('stages')
      .insert({ pipeline_id: selectedId, name: name.trim(), position: nextPos, is_won: false, is_lost: false })
      .select('*')
      .single();
    if (err) {
      setError(err.message);
      return;
    }
    setStages((cur) => [...cur, data as Stage]);
  }, [selectedId, stages]);

  const renameStage = useCallback(async (id: string, name: string) => {
    const supabase = getSupabase();
    setStages((cur) => cur.map((s) => (s.id === id ? { ...s, name } : s)));
    const { error: err } = await supabase.from('stages').update({ name: name.trim() }).eq('id', id);
    if (err) setError(err.message);
  }, []);

  const setStageColor = useCallback(async (id: string, color: string | null) => {
    const supabase = getSupabase();
    setStages((cur) => cur.map((s) => (s.id === id ? { ...s, color } : s)));
    const { error: err } = await supabase.from('stages').update({ color }).eq('id', id);
    if (err) setError(err.message);
  }, []);

  const setStageProbability = useCallback(async (id: string, probability: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(probability)));
    const supabase = getSupabase();
    setStages((cur) => cur.map((s) => (s.id === id ? { ...s, probability: clamped } : s)));
    const { error: err } = await supabase.from('stages').update({ probability: clamped }).eq('id', id);
    if (err) setError(err.message);
  }, []);

  const setStageAiCriteria = useCallback(async (id: string, criteria: string | null) => {
    const value = criteria && criteria.trim() ? criteria.trim() : null;
    const supabase = getSupabase();
    setStages((cur) => cur.map((s) => (s.id === id ? { ...s, ai_criteria: value } : s)));
    const { error: err } = await supabase.from('stages').update({ ai_criteria: value }).eq('id', id);
    if (err) setError(err.message);
  }, []);

  const reorderStages = useCallback(async (orderedIds: string[]) => {
    setStages((cur) => {
      const byId = new Map(cur.map((s) => [s.id, s]));
      return orderedIds.map((id, i) => ({ ...(byId.get(id) as Stage), position: i }));
    });
    const supabase = getSupabase();
    await Promise.all(orderedIds.map((id, i) => supabase.from('stages').update({ position: i }).eq('id', id)));
  }, []);

  const removeStage = useCallback<UsePipelineResult['removeStage']>(
    async (id, moveToStageId) => {
      if (stages.length <= 1) return { ok: false, error: 'O funil precisa de ao menos um estágio.' };
      const supabase = getSupabase();
      // Move os deals do estágio para o destino escolhido antes de excluir.
      const { error: mvErr } = await supabase.from('deals').update({ stage_id: moveToStageId }).eq('stage_id', id);
      if (mvErr) return { ok: false, error: mvErr.message };
      const { error: delErr } = await supabase.from('stages').delete().eq('id', id);
      if (delErr) return { ok: false, error: delErr.message };
      setStages((cur) => cur.filter((s) => s.id !== id));
      setDeals((cur) => cur.map((d) => (d.stage_id === id ? { ...d, stage_id: moveToStageId } : d)));
      return { ok: true };
    },
    [stages],
  );

  return {
    pipelines, selectedId, select, pipeline, stages, deals, nextActionByDeal, convByContact, loading, error, reload,
    moveDeal, createDeal, archiveDeal, unarchiveDeal,
    createPipeline, renamePipeline, deletePipeline, setDefaultPipeline,
    addStage, renameStage, setStageColor, setStageProbability, setStageAiCriteria, reorderStages, removeStage,
  };
}
