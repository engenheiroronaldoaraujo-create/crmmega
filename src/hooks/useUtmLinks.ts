import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export interface UtmLink {
  id: string;
  base_url: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  final_url: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
}

export interface UtmLinkInput {
  base_url: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  final_url: string;
  label?: string | null;
}

export function useUtmLinks() {
  const { userId } = useAppUser();
  const [links, setLinks] = useState<UtmLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('utm_links')
      .select('*')
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    setLinks((data ?? []) as UtmLink[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: UtmLinkInput): Promise<UtmLink | null> => {
      const supabase = getSupabase();
      const { data, error: err } = await supabase
        .from('utm_links')
        .insert({ ...input, created_by: userId ?? null })
        .select('*')
        .single();
      if (err) throw new Error(err.message);
      const row = data as UtmLink;
      setLinks((prev) => [row, ...prev]);
      return row;
    },
    [userId],
  );

  const remove = useCallback(async (id: string) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.from('utm_links').delete().eq('id', id);
    if (err) throw new Error(err.message);
    setLinks((prev) => prev.filter((l) => l.id !== id));
  }, []);

  return { links, loading, error, reload, create, remove };
}
