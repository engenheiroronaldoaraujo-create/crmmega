import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export type NotificationType = 'new_message' | 'handoff' | 'mention';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  conversation_id: string | null;
  message_id: string | null;
  title: string;
  body: string | null;
  is_read: boolean;
  created_at: string;
}

interface UseNotificationsResult {
  notifications: NotificationRow[];
  unreadCount: number;
  loading: boolean;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reload: () => Promise<void>;
}

// Shared AudioContext lazily created on first use. Browsers block autoplay
// unless audio starts from a user gesture — the context is fine to create
// up front but we only call resume() after a click in the dropdown.
let audioCtx: AudioContext | null = null;
function ding() {
  try {
    if (!audioCtx) {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(440, audioCtx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch {
    // Some browsers reject AudioContext creation until a user gesture; the
    // tradeoff of a silent first notification is fine.
  }
}

export function useNotifications(): UseNotificationsResult {
  const { userId } = useAppUser();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Keep a ref to the current unread count so realtime handler can decide
  // whether to play sound without a render tick delay.
  const lastSoundAt = useRef<number>(0);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const supabase = getSupabase();
    const { data } = await supabase
      .schema('whatsapp_hub')
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    setNotifications((data ?? []) as NotificationRow[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Realtime: subscribe to INSERT/UPDATE on rows belonging to the caller.
  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    const suffix = Math.random().toString(36).slice(2, 10);
    const channel = supabase
      .channel(`notifications:${userId}:${suffix}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'whatsapp_hub',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as NotificationRow;
          setNotifications((prev) => (prev.some((n) => n.id === row.id) ? prev : [row, ...prev].slice(0, 50)));
          // Debounce the ding so burst inserts don't stack sounds.
          const now = Date.now();
          if (now - lastSoundAt.current > 800) {
            lastSoundAt.current = now;
            ding();
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'whatsapp_hub',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as NotificationRow;
          setNotifications((prev) => prev.map((n) => (n.id === row.id ? row : n)));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  const markRead = useCallback(async (id: string) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id);
    if (!error) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
      );
    }
  }, []);

  const markAllRead = useCallback(async () => {
    if (!userId) return;
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (!error) {
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    }
  }, [userId]);

  const unreadCount = notifications.reduce((acc, n) => acc + (n.is_read ? 0 : 1), 0);

  // Aviso na aba do navegador: prefixa o título com (N) enquanto houver não
  // lidas e a aba estiver sem foco; restaura ao focar.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    const apply = () => {
      document.title =
        unreadCount > 0 && !document.hasFocus() ? `(${unreadCount}) ${base}` : base;
    };
    apply();
    window.addEventListener('focus', apply);
    window.addEventListener('blur', apply);
    return () => {
      window.removeEventListener('focus', apply);
      window.removeEventListener('blur', apply);
      document.title = base;
    };
  }, [unreadCount]);

  return { notifications, unreadCount, loading, markRead, markAllRead, reload };
}
