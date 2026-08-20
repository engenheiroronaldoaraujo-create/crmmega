import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import type { Contact } from '@/types/db';
import type { Message } from '@/types/inbox';
import type { Deal } from '@/types/crm';

export interface TimelineItem {
  id: string;
  at: string;
  kind: 'in' | 'ai' | 'out' | 'note' | 'task';
  label: string;
  text: string;
  done?: boolean;
}

interface UseContactProfileResult {
  contact: Contact | null;
  timeline: TimelineItem[];
  deals: Deal[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  addNote: (body: string) => Promise<void>;
  saveContact: (patch: Partial<Pick<Contact, 'name' | 'phone' | 'email' | 'source' | 'custom_fields'>>) => Promise<string | null>;
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[imagem]',
  audio: '[áudio]',
  video: '[vídeo]',
  document: '[documento]',
  template: '[template]',
};

export function useContactProfile(id: string): UseContactProfileResult {
  const [contact, setContact] = useState<Contact | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    const { data: c, error: cErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', id)
      .single();
    if (cErr) {
      setError(cErr.message);
      setLoading(false);
      return;
    }
    setContact(c as Contact);

    // Conversa do contato (1:1) → mensagens
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', id)
      .maybeSingle();

    const [msgsRes, actsRes, dealsRes] = await Promise.all([
      conv?.id
        ? supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(200)
        : Promise.resolve({ data: [] as Message[] }),
      supabase
        .from('crm_activities')
        .select('*')
        .eq('contact_id', id)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('deals').select('*').eq('contact_id', id),
    ]);

    const msgItems: TimelineItem[] = ((msgsRes.data ?? []) as Message[])
      .filter((m) => !m.is_private_note || true)
      .map((m) => {
        const isIn = m.direction === 'inbound';
        const kind: TimelineItem['kind'] = isIn
          ? 'in'
          : m.sender_type === 'ai'
            ? 'ai'
            : 'out';
        const label = m.is_private_note
          ? 'Nota interna'
          : isIn
            ? 'Cliente'
            : m.sender_type === 'ai'
              ? 'IA'
              : 'Você';
        return {
          id: `m-${m.id}`,
          at: m.created_at,
          kind,
          label,
          text: m.content ?? MEDIA_LABEL[m.content_type] ?? '[mídia]',
        };
      });

    const actItems: TimelineItem[] = ((actsRes.data ?? []) as Array<{
      id: string;
      type: string;
      title: string | null;
      body: string | null;
      done: boolean;
      created_at: string;
    }>).map((a) => ({
      id: `a-${a.id}`,
      at: a.created_at,
      kind: a.type === 'note' ? 'note' : 'task',
      label: a.type === 'note' ? 'Nota' : a.type,
      text: a.body ?? a.title ?? '',
      done: a.done,
    }));

    setTimeline(
      [...msgItems, ...actItems].sort(
        (x, y) => +new Date(y.at) - +new Date(x.at),
      ),
    );
    setDeals((dealsRes.data ?? []) as Deal[]);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addNote = useCallback(
    async (body: string) => {
      const text = body.trim();
      if (!text) return;
      const supabase = getSupabase();
      const { error: err } = await supabase
        .from('crm_activities')
        .insert({ contact_id: id, type: 'note', body: text });
      if (err) {
        setError(err.message);
        return;
      }
      await reload();
    },
    [id, reload],
  );

  const saveContact = useCallback<UseContactProfileResult['saveContact']>(
    async (patch) => {
      const supabase = getSupabase();
      setContact((cur) => (cur ? ({ ...cur, ...patch } as Contact) : cur));
      const { error: err } = await supabase
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (err) {
        setError(err.message);
        return err.message;
      }
      return null;
    },
    [id],
  );

  return { contact, timeline, deals, loading, error, reload, addNote, saveContact };
}
