import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { Tag } from '@/types/db';

// Tag CRUD for the single-org install. RLS still gates non-authenticated
// callers; role-based gating is enforced by the policies in the migration.

interface UseTagsResult {
  tags: Tag[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: { name: string; color: string }) => Promise<Tag | null>;
  update: (id: string, patch: Partial<Pick<Tag, 'name' | 'color'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useTags(): UseTagsResult {
  const { userId } = useAppUser();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('tags')
      .select('*')
      .order('name', { ascending: true });
    if (err) setError(err.message);
    else setTags((data ?? []) as Tag[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create: UseTagsResult['create'] = async ({ name, color }) => {
    if (!userId) return null;
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('tags')
      .insert({ name: name.trim(), color })
      .select()
      .single();
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
    return data as Tag;
  };

  const update: UseTagsResult['update'] = async (id, patch) => {
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('tags')
      .update(patch)
      .eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const remove: UseTagsResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('tags').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return { tags, loading, error, reload, create, update, remove };
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
