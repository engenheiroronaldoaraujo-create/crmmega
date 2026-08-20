import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface QueueMember {
  user_id: string;
  // Nome exibível: display_name do perfil, senão a parte local do e-mail.
  email: string;
  position: number;
}

export interface QueueOperator {
  user_id: string;
  email: string;
}

// display_name do perfil, senão a parte local do e-mail.
function labelFor(row: { email: string; display_name?: string | null }): string {
  return row.display_name?.trim() || row.email.split('@')[0];
}

interface UseLeadAssignmentQueueResult {
  enabled: boolean;
  queue: QueueMember[];
  // Operadores/admins fora da fila (candidatos a adicionar).
  available: QueueOperator[];
  loading: boolean;
  reload: () => Promise<void>;
  toggle: (enabled: boolean) => Promise<void>;
  add: (userId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
}

// Fila do round-robin de leads + flag global auto_assign_enabled (settings da app).
// Escrita gated a admin pela RLS; erros propagados (throw) para toast no componente.
export function useLeadAssignmentQueue(): UseLeadAssignmentQueueResult {
  const [enabled, setEnabled] = useState(false);
  const [queue, setQueue] = useState<QueueMember[]>([]);
  const [available, setAvailable] = useState<QueueOperator[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const supabase = getSupabase();
    const [settingsRes, queueRes, opsRes] = await Promise.all([
      supabase.from('app_settings').select('auto_assign_enabled').limit(1).maybeSingle(),
      supabase.from('lead_assignment_queue').select('user_id, position').order('position', { ascending: true }),
      supabase.schema('whatsapp_hub').rpc('list_operators'),
    ]);

    setEnabled(Boolean((settingsRes.data as { auto_assign_enabled?: boolean } | null)?.auto_assign_enabled));

    const ops = (opsRes.data ?? []) as Array<{ user_id: string; email: string; display_name?: string | null }>;
    const labelByUser = new Map<string, string>(ops.map((o) => [o.user_id, labelFor(o)]));
    const rows = (queueRes.data ?? []) as Array<{ user_id: string; position: number }>;
    const inQueue = new Set(rows.map((r) => r.user_id));
    setQueue(rows.map((r) => ({ user_id: r.user_id, position: r.position, email: labelByUser.get(r.user_id) ?? r.user_id })));
    setAvailable(
      ops
        .filter((o) => !inQueue.has(o.user_id))
        .map((o) => ({ user_id: o.user_id, email: labelFor(o) })),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload().catch(() => setLoading(false));
  }, [reload]);

  const toggle = useCallback<UseLeadAssignmentQueueResult['toggle']>(
    async (next) => {
      const supabase = getSupabase();
      setEnabled(next);
      // Sem eq('id', 1) fixo (o singleton pode ter outro id) e com .select()
      // para detectar update de 0 linhas — RLS filtrando silenciosamente
      // aparecia como "toggle bugado" (ligava e voltava sozinho).
      const { data, error } = await supabase
        .from('app_settings')
        .update({ auto_assign_enabled: next, updated_at: new Date().toISOString() })
        .not('id', 'is', null)
        .select('auto_assign_enabled');
      if (error || !data || data.length === 0) {
        setEnabled(!next);
        throw new Error(error?.message ?? 'Sem permissão para alterar (apenas admins).');
      }
      setEnabled(Boolean((data[0] as { auto_assign_enabled: boolean }).auto_assign_enabled));
    },
    [],
  );

  const add = useCallback<UseLeadAssignmentQueueResult['add']>(
    async (userId) => {
      const supabase = getSupabase();
      const nextPos = queue.reduce((m, q) => Math.max(m, q.position), -1) + 1;
      const { error } = await supabase.from('lead_assignment_queue').insert({ user_id: userId, position: nextPos });
      if (error) throw new Error(error.message);
      await reload();
    },
    [queue, reload],
  );

  const remove = useCallback<UseLeadAssignmentQueueResult['remove']>(
    async (userId) => {
      const supabase = getSupabase();
      const { error } = await supabase.from('lead_assignment_queue').delete().eq('user_id', userId);
      if (error) throw new Error(error.message);
      await reload();
    },
    [reload],
  );

  const reorder = useCallback<UseLeadAssignmentQueueResult['reorder']>(
    async (orderedIds) => {
      const supabase = getSupabase();
      setQueue((cur) => {
        const byId = new Map(cur.map((q) => [q.user_id, q]));
        return orderedIds.map((id, i) => ({ ...(byId.get(id) as QueueMember), position: i }));
      });
      await Promise.all(
        orderedIds.map((id, i) => supabase.from('lead_assignment_queue').update({ position: i }).eq('user_id', id)),
      );
    },
    [],
  );

  return { enabled, queue, available, loading, reload, toggle, add, remove, reorder };
}
