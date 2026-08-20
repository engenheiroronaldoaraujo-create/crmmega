import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { WIDGETS, type WidgetKey } from '@/lib/dashboard';

interface PrefRow {
  id: string;
  user_id: string | null;
  widget_key: string;
  visible: boolean;
  position: number;
}

// Visibilidade efetiva: default da instância (user_id NULL) sobrescrito pela
// preferência do usuário. Sem registro → visível. Toggles gravam por usuário.
export function useDashboardPrefs() {
  const { userId } = useAppUser();
  const [rows, setRows] = useState<PrefRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const supabase = getSupabase();
    // RLS já restringe a "minhas linhas + defaults".
    const { data } = await supabase.from('dashboard_preferences').select('*');
    setRows((data ?? []) as PrefRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { visibleMap, myRowByKey } = useMemo(() => {
    const defaults = new Map<string, boolean>();
    const mine = new Map<string, PrefRow>();
    for (const r of rows) {
      if (r.user_id === null) defaults.set(r.widget_key, r.visible);
      else if (r.user_id === userId) mine.set(r.widget_key, r);
    }
    const map = {} as Record<WidgetKey, boolean>;
    for (const w of WIDGETS) {
      const mineRow = mine.get(w.key);
      if (mineRow) map[w.key] = mineRow.visible;
      else if (defaults.has(w.key)) map[w.key] = defaults.get(w.key)!;
      else map[w.key] = true;
    }
    return { visibleMap: map, myRowByKey: mine };
  }, [rows, userId]);

  const toggle = useCallback(
    async (key: WidgetKey): Promise<string | null> => {
      if (!userId) return null;
      const next = !visibleMap[key];
      const supabase = getSupabase();
      const existing = myRowByKey.get(key);
      if (existing) {
        setRows((cur) => cur.map((r) => (r.id === existing.id ? { ...r, visible: next } : r)));
        await supabase.from('dashboard_preferences').update({ visible: next }).eq('id', existing.id);
        return existing.id;
      }
      const { data, error } = await supabase
        .from('dashboard_preferences')
        .insert({ user_id: userId, widget_key: key, visible: next })
        .select('*')
        .single();
      if (error || !data) return null;
      const row = data as PrefRow;
      setRows((cur) => [...cur, row]);
      return row.id;
    },
    [userId, visibleMap, myRowByKey],
  );

  return { visibleMap, toggle, loading, reload };
}
