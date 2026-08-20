import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface ContactChannelLink {
  id: string;
  contact_id: string;
  channel: 'whatsapp' | 'instagram';
  channel_identifier: string;
  created_at: string;
}

// Vínculos de identidade de canal (IG ↔ WhatsApp) de um contato (Módulo 5.2).
export function useContactChannelLinks(contactId: string) {
  const [links, setLinks] = useState<ContactChannelLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('contact_channel_links')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true });
    if (err) setError(err.message);
    setLinks((data ?? []) as ContactChannelLink[]);
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const link = useCallback(
    async (channel: 'whatsapp' | 'instagram', identifier: string) => {
      const id = identifier.trim();
      if (!id) return;
      const supabase = getSupabase();
      const { error: err } = await supabase
        .from('contact_channel_links')
        .insert({ contact_id: contactId, channel, channel_identifier: id });
      if (err) throw new Error(err.message);
      await reload();
    },
    [contactId, reload],
  );

  const unlink = useCallback(
    async (id: string) => {
      const supabase = getSupabase();
      const { error: err } = await supabase.from('contact_channel_links').delete().eq('id', id);
      if (err) throw new Error(err.message);
      setLinks((cur) => cur.filter((l) => l.id !== id));
    },
    [],
  );

  return { links, loading, error, reload, link, unlink };
}
