import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { FollowUpRule } from '@/types/campaigns';

interface UseFollowUpRulesResult {
  rules: FollowUpRule[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: Omit<FollowUpRule, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  update: (id: string, patch: Partial<FollowUpRule>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useFollowUpRules(): UseFollowUpRulesResult {
  const { userId } = useAppUser();
  const [rules, setRules] = useState<FollowUpRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('follow_up_rules')
      .select('*')
      .order('sequence_order', { ascending: true });
    if (err) setError(err.message);
    else setRules((data ?? []) as FollowUpRule[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create: UseFollowUpRulesResult['create'] = async (input) => {
    if (!userId) return;
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('follow_up_rules')
      .insert(input);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const update: UseFollowUpRulesResult['update'] = async (id, patch) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('follow_up_rules').update(patch).eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const remove: UseFollowUpRulesResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('follow_up_rules').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return { rules, loading, error, reload, create, update, remove };
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
