import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { Conversation, ConversationStatus, ConversationWithContact } from '@/types/inbox';

interface UseConversationsResult {
  conversations: ConversationWithContact[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setStatus: (id: string, status: ConversationStatus) => Promise<void>;
  setAiPaused: (id: string, paused: boolean) => Promise<void>;
  setAssigned: (id: string, userId: string | null) => Promise<void>;
  setActiveDeal: (id: string, dealId: string | null) => Promise<void>;
  setPinnedNote: (id: string, note: string | null) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  markRead: (id: string) => Promise<void>;
}

interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  profile_pic_url: string | null;
  custom_fields: Record<string, unknown>;
}

// PostgREST recebe filtros `.in()` na query string: com centenas de UUIDs a
// URL estoura o limite do gateway do Supabase e a request morre com um 400
// "Bad Request" genérico. Fatiamos as listas de ids e mesclamos os resultados.
const IN_CHUNK_SIZE = 100;

async function fetchInChunks<T>(
  ids: string[],
  fetchPage: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) chunks.push(ids.slice(i, i + IN_CHUNK_SIZE));
  const pages = await Promise.all(chunks.map((chunk) => fetchPage(chunk)));
  const out: T[] = [];
  for (const page of pages) {
    if (page.error) return { data: out, error: page.error };
    out.push(...(page.data ?? []));
  }
  return { data: out, error: null };
}

export function useConversations(): UseConversationsResult {
  const { userId } = useAppUser();
  const [conversations, setConversations] = useState<ConversationWithContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `silent` refaz a lista SEM ligar o estado de loading — usado pelos refreshes
  // do realtime para não repintar a lista com "Carregando..." a cada mensagem
  // (era a causa do "pisca"). Só o load inicial / retry manual mostra loading.
  const load = useCallback(async (silent = false) => {
    if (!userId) return;
    if (!silent) setLoading(true);
    setError(null);
    const supabase = getSupabase();

    // Buscamos TODAS as conversas (arquivadas ou não, qualquer status) e a
    // filtragem por canal / atendente / status / atribuído / tags / janela 24h
    // acontece no cliente (Módulo 7) — combinações multi-eixo ficam simples e
    // reativas. Débito: para volumes grandes, empurrar filtros para o servidor.
    const { data: convs, error: err } = await supabase
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    const rows = (convs ?? []) as Conversation[];
    const contactIds = Array.from(new Set(rows.map((c) => c.contact_id)));
    const conversationIds = rows.map((c) => c.id);

    // Batch: contacts + tags do contato + latest messages + clientes (deals).
    // Cada lista de ids vai fatiada (fetchInChunks) para a URL não estourar.
    const [contactsQ, tagsQ, lastMsgsQ, clientesQ] = await Promise.all([
      fetchInChunks<ContactRow>(contactIds, (chunk) =>
        supabase
          .from('contacts')
          .select('id, phone, name, email, profile_pic_url, custom_fields')
          .in('id', chunk),
      ),
      fetchInChunks<{ contact_id: string; tag_id: string }>(contactIds, (chunk) =>
        supabase
          .from('contact_tags')
          .select('contact_id, tag_id')
          .in('contact_id', chunk),
      ),
      fetchInChunks(conversationIds, (chunk) =>
        supabase
          .from('messages')
          .select('conversation_id, content, content_type, created_at, is_private_note, direction')
          .in('conversation_id', chunk)
          .order('created_at', { ascending: false }),
      ),
      fetchInChunks<{ contact_id: string }>(contactIds, (chunk) =>
        supabase
          .from('deals')
          .select('contact_id')
          .eq('lead_type', 'Cliente')
          .in('contact_id', chunk),
      ),
    ]);

    if (contactsQ.error) {
      setError(contactsQ.error.message);
      setLoading(false);
      return;
    }
    const contactsById = new Map<string, ContactRow>();
    for (const c of (contactsQ.data ?? []) as ContactRow[]) contactsById.set(c.id, c);

    // Tags por contato (para o filtro de Tags do inbox).
    const tagsByContact = new Map<string, string[]>();
    for (const t of (tagsQ.data ?? []) as Array<{ contact_id: string; tag_id: string }>) {
      const arr = tagsByContact.get(t.contact_id) ?? [];
      arr.push(t.tag_id);
      tagsByContact.set(t.contact_id, arr);
    }

    // Percorre mensagens (ordenadas desc): 1ª não-privada = preview; 1ª inbound
    // = última mensagem do contato (janela de 24h).
    const latestByConv = new Map<string, string>();
    const lastInboundByConv = new Map<string, string>();
    for (const m of (lastMsgsQ.data ?? []) as Array<{
      conversation_id: string;
      content: string | null;
      content_type: string;
      is_private_note: boolean;
      direction: 'inbound' | 'outbound';
      created_at: string;
    }>) {
      if (!latestByConv.has(m.conversation_id) && !m.is_private_note) {
        const preview = m.content ?? (m.content_type === 'text' ? '' : `[${m.content_type}]`);
        latestByConv.set(m.conversation_id, preview);
      }
      if (m.direction === 'inbound' && !lastInboundByConv.has(m.conversation_id)) {
        lastInboundByConv.set(m.conversation_id, m.created_at);
      }
    }

    const clienteSet = new Set(
      ((clientesQ.data ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id),
    );

    const merged: ConversationWithContact[] = rows.map((c) => ({
      ...c,
      contact: contactsById.get(c.contact_id) ?? null,
      lastMessagePreview: latestByConv.get(c.id) ?? null,
      tagIds: tagsByContact.get(c.contact_id) ?? [],
      lastInboundAt: lastInboundByConv.get(c.id) ?? null,
      isCliente: clienteSet.has(c.contact_id),
    }));

    setConversations(merged);
    setLoading(false);
  }, [userId]);

  // API pública: recarrega mostrando loading (load inicial / retry manual).
  const reload = useCallback(() => load(false), [load]);

  // Refresh do realtime: silencioso e com debounce, para coalescer rajadas de
  // eventos (várias mensagens chegando juntas) num único refetch sem flicker.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSilentReload = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void load(true);
    }, 300);
  }, [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  // Realtime subscription — any INSERT/UPDATE/DELETE on conversations OR a
  // new row in messages (which bumps last_message_at) triggers a refresh.
  // Randomized channel names to survive StrictMode double-mount.
  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    const suffix = Math.random().toString(36).slice(2, 10);
    const channel = supabase
      .channel(`inbox:${suffix}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'whatsapp_hub',
          table: 'conversations',
        },
        () => { scheduleSilentReload(); },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'whatsapp_hub',
          table: 'messages',
        },
        () => { scheduleSilentReload(); },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, scheduleSilentReload]);

  const setStatus: UseConversationsResult['setStatus'] = async (id, next) => {
    const supabase = getSupabase();
    const patch: Record<string, unknown> = { status: next };
    if (next === 'closed') patch.closed_at = new Date().toISOString();
    const { error } = await supabase.schema('whatsapp_hub').from('conversations').update(patch).eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  const setAiPaused: UseConversationsResult['setAiPaused'] = async (id, paused) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('conversations')
      .update({ ai_paused: paused, status: paused ? 'human_active' : 'ai_active' })
      .eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  const setAssigned: UseConversationsResult['setAssigned'] = async (id, assignee) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('conversations')
      .update({ assigned_to: assignee, assigned_at: assignee ? new Date().toISOString() : null })
      .eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  // Negócio ativo da conversa — independente de assigned_to (responsável).
  const setActiveDeal: UseConversationsResult['setActiveDeal'] = async (id, dealId) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('conversations')
      .update({ active_deal_id: dealId })
      .eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  const setPinnedNote: UseConversationsResult['setPinnedNote'] = async (id, note) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('conversations')
      .update({ pinned_note: note && note.trim() ? note.trim() : null })
      .eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  const setArchived: UseConversationsResult['setArchived'] = async (id, archived) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('conversations')
      .update({ archived })
      .eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  const markRead: UseConversationsResult['markRead'] = async (id) => {
    const supabase = getSupabase();
    const { error } = await supabase.schema('whatsapp_hub').from('conversations').update({ unread_count: 0 }).eq('id', id);
    if (error) throw new Error(translateDbError(error.message));
  };

  return { conversations, loading, error, reload, setStatus, setAiPaused, setAssigned, setActiveDeal, setPinnedNote, setArchived, markRead };
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
