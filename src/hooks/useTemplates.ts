import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { Template } from '@/types/templates';

interface UseTemplatesResult {
  templates: Template[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: Omit<Template, 'id' | 'created_at' | 'updated_at' | 'status' | 'meta_template_id' | 'meta_template_status' | 'submitted_at' | 'approved_at'>) => Promise<Template | null>;
  update: (id: string, patch: Partial<Template>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useTemplates(): UseTemplatesResult {
  const { userId } = useAppUser();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    else setTemplates((data ?? []) as Template[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create: UseTemplatesResult['create'] = async (input) => {
    if (!userId) return null;
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('templates')
      .insert({ ...input, status: 'draft' })
      .select()
      .single();
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
    return data as Template;
  };

  const update: UseTemplatesResult['update'] = async (id, patch) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('templates').update(patch).eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const remove: UseTemplatesResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('templates').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return { templates, loading, error, reload, create, update, remove };
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
