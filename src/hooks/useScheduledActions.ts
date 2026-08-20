import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { CRM_ACTION_TYPES, type CrmActionType, type CrmActivity } from '@/types/crm';

// Ação agendada com o título do negócio ancorado (preenchido no contexto de
// contato, onde ações de vários negócios convivem na mesma lista).
export interface ScheduledAction extends CrmActivity {
  dealTitle?: string | null;
}

interface ScheduleInput {
  dealId: string;
  text: string;
  dueAt: string; // ISO
  type: CrmActionType;
}

interface UseScheduledActionsResult {
  actions: ScheduledAction[];
  loading: boolean;
  reload: () => Promise<void>;
  schedule: (input: ScheduleInput) => Promise<void>;
  complete: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const ACTION_SELECT =
  'id, deal_id, contact_id, type, title, body, due_at, done, done_at, owner_id, created_at';

// Lista/gera ações agendadas (crm_activities com due_at). Escopo por deal (drawer
// do funil / inbox) OU por contato (ficha do contato: agrega todos os negócios).
// Erros são propagados (throw) para o componente exibir toast — padrão do inbox.
export function useScheduledActions({
  dealId,
  contactId,
}: {
  dealId?: string;
  contactId?: string;
}): UseScheduledActionsResult {
  const [actions, setActions] = useState<ScheduledAction[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!dealId && !contactId) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const supabase = getSupabase();

    if (dealId) {
      const { data, error } = await supabase
        .from('crm_activities')
        .select(ACTION_SELECT)
        .eq('deal_id', dealId)
        .in('type', CRM_ACTION_TYPES)
        .not('due_at', 'is', null)
        .order('due_at', { ascending: true });
      if (error) {
        setLoading(false);
        throw new Error(error.message);
      }
      setActions((data ?? []) as ScheduledAction[]);
      setLoading(false);
      return;
    }

    // Contexto de contato: acha os negócios do contato p/ filtrar e rotular.
    const { data: deals } = await supabase
      .from('deals')
      .select('id, title')
      .eq('contact_id', contactId);
    const dealList = (deals ?? []) as Array<{ id: string; title: string }>;
    const titleById = new Map(dealList.map((d) => [d.id, d.title]));
    const dealIds = dealList.map((d) => d.id);
    if (dealIds.length === 0) {
      setActions([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('crm_activities')
      .select(ACTION_SELECT)
      .in('deal_id', dealIds)
      .in('type', CRM_ACTION_TYPES)
      .not('due_at', 'is', null)
      .order('due_at', { ascending: true });
    if (error) {
      setLoading(false);
      throw new Error(error.message);
    }
    setActions(
      ((data ?? []) as ScheduledAction[]).map((a) => ({
        ...a,
        dealTitle: a.deal_id ? titleById.get(a.deal_id) ?? null : null,
      })),
    );
    setLoading(false);
  }, [dealId, contactId]);

  useEffect(() => {
    void reload().catch(() => setLoading(false));
  }, [reload]);

  const schedule = useCallback<UseScheduledActionsResult['schedule']>(
    async ({ dealId: targetDeal, text, dueAt, type }) => {
      const supabase = getSupabase();
      // contact_id denormalizado a partir do negócio.
      const { data: deal } = await supabase
        .from('deals')
        .select('contact_id')
        .eq('id', targetDeal)
        .single();
      const { error } = await supabase.from('crm_activities').insert({
        deal_id: targetDeal,
        contact_id: (deal as { contact_id: string } | null)?.contact_id ?? null,
        type,
        body: text.trim(),
        due_at: dueAt,
        done: false,
      });
      if (error) throw new Error(error.message);
      await reload();
    },
    [reload],
  );

  const complete = useCallback<UseScheduledActionsResult['complete']>(
    async (id) => {
      const supabase = getSupabase();
      const { error } = await supabase
        .from('crm_activities')
        .update({ done: true, done_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
      await reload();
    },
    [reload],
  );

  const remove = useCallback<UseScheduledActionsResult['remove']>(
    async (id) => {
      const supabase = getSupabase();
      const { error } = await supabase.from('crm_activities').delete().eq('id', id);
      if (error) throw new Error(error.message);
      await reload();
    },
    [reload],
  );

  return { actions, loading, reload, schedule, complete, remove };
}
