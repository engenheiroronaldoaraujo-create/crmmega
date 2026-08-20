import { useCallback, useEffect, useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { KnowledgeBase } from '@/types/knowledge';

interface UseKnowledgeBaseResult {
  items: KnowledgeBase[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  addAndProcess: (input: {
    name: string;
    source_type: 'text' | 'url' | 'pdf';
    content: string;
  }) => Promise<{ knowledge_base_id: string; chunks?: number; error?: string } | null>;
  uploadPdf: (file: File) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
}

const KNOWLEDGE_BUCKET = 'whatsapp-hub-knowledge';

export function useKnowledgeBase(): UseKnowledgeBaseResult {
  const { userId, orgId } = useAppUser();
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('knowledge_base')
      .select('*')
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    else setItems((data ?? []) as KnowledgeBase[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Light realtime: any change to knowledge_base rows bumps the list.
  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    const suffix = Math.random().toString(36).slice(2, 10);
    const channel = supabase
      .channel(`knowledge:${suffix}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'whatsapp_hub',
          table: 'knowledge_base',
        },
        () => { void reload(); },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, reload]);

  const uploadPdf: UseKnowledgeBaseResult['uploadPdf'] = async (file) => {
    if (!userId || !orgId) return null;
    const supabase = getSupabase();
    // O path DEVE começar com `<org_id>/` — a policy RLS de INSERT do bucket
    // whatsapp-hub-knowledge exige (storage.foldername(name))[1] = current_org_id().
    // Sem o prefixo, o upload é bloqueado por RLS (row-level security).
    const path = `${orgId}/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(KNOWLEDGE_BUCKET)
      .upload(path, file, { contentType: 'application/pdf', upsert: false });
    if (upErr) {
      setError(upErr.message);
      throw new Error(translateDbError(upErr.message));
    }
    return path;
  };

  const addAndProcess: UseKnowledgeBaseResult['addAndProcess'] = async ({ name, source_type, content }) => {
    if (!userId) return null;
    const supabase = getSupabase();

    // Create the parent row first with status=processing; process-knowledge
    // flips it to ready/error.
    const { data: row, error: insErr } = await supabase
      .from('knowledge_base')
      .insert({
        name: name.trim(),
        type: source_type === 'url' ? 'url' : source_type === 'pdf' ? 'pdf' : 'doc',
        source_url: source_type === 'url' ? content.trim() : null,
        file_path: source_type === 'pdf' ? content : null,
        status: 'processing',
      })
      .select()
      .single();
    if (insErr || !row) {
      setError(insErr?.message ?? 'Falha ao criar entrada');
      throw new Error(translateDbError(insErr?.message ?? 'Falha ao criar entrada'));
    }
    const created = row as KnowledgeBase;

    const { data, error: fnErr } = await supabase.functions.invoke('process-knowledge', {
      body: {
        knowledge_base_id: created.id,
        source_type,
        content,
      },
    });

    if (fnErr || !data?.ok) {
      // Keep the row so the error is visible in the list; the function
      // itself should have flipped status=error. O corpo real ({ error }) do
      // process-knowledge quando responde non-2xx NÃO vem em `data` — o
      // supabase-js embrulha num FunctionsHttpError e joga o Response em
      // `fnErr.context`. Lemos ele para mostrar a razão de verdade em vez do
      // genérico "Edge Function returned a non-2xx status code".
      let message = data?.error ?? '';
      if (!message && fnErr instanceof FunctionsHttpError) {
        try {
          const body = await fnErr.context.json();
          message = (body?.error as string | undefined) ?? '';
        } catch {
          /* corpo não-JSON — cai no fallback abaixo */
        }
      }
      message = friendlyOpenAiError(message || fnErr?.message || 'Falha ao processar');
      setError(message);
      await reload();
      return { knowledge_base_id: created.id, error: message };
    }
    await reload();
    return { knowledge_base_id: created.id, chunks: data.chunks as number };
  };

  const remove: UseKnowledgeBaseResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('knowledge_base').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return { items, loading, error, reload, addAndProcess, uploadPdf, remove };
}

// Traduz erros crus da OpenAI (401 / cota) numa mensagem amigável. O
// process-knowledge repassa o corpo da OpenAI quando embeddings/visão falham.
function friendlyOpenAiError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('invalid_api_key') ||
    lower.includes('incorrect api key') ||
    lower.includes('insufficient_quota') ||
    lower.includes('exceeded your current quota') ||
    /openai\D+(401|429)/.test(lower)
  ) {
    return 'Chave de API da OpenAI inválida ou sem saldo. Atualize em Agente de IA → Configurações Avançadas.';
  }
  return message;
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
