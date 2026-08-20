import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export type DashboardPeriod = '7d' | '30d' | '90d';

export interface CampaignAgg {
  id: string;
  name: string;
  status: string;
  total_contacts: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  created_at: string;
}

export interface VolumeByDay {
  day: string; // YYYY-MM-DD
  inbound: number;
  outbound: number;
}

export interface ConversationStatusDistribution {
  ai_active: number;
  human_active: number;
  closed: number;
  total: number;
}

interface UseDashboardMetricsResult {
  loading: boolean;
  error: string | null;
  reload: () => void;
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  totals: {
    total_contacts: number;
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
    deliveryRate: number; // 0..100
    readRate: number;
    replyRate: number;
  };
  campaigns: CampaignAgg[];
  volumeByDay: VolumeByDay[];
  conversationStatus: ConversationStatusDistribution;
}

function periodDays(p: DashboardPeriod): number {
  return p === '7d' ? 7 : p === '30d' ? 30 : 90;
}

export function useDashboardMetrics(): UseDashboardMetricsResult {
  const { userId } = useAppUser();
  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [campaigns, setCampaigns] = useState<CampaignAgg[]>([]);
  const [volumeByDay, setVolumeByDay] = useState<VolumeByDay[]>([]);
  const [conversationStatus, setConversationStatus] = useState<ConversationStatusDistribution>({
    ai_active: 0,
    human_active: 0,
    closed: 0,
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    const since = new Date();
    since.setDate(since.getDate() - periodDays(period));
    const sinceIso = since.toISOString();

    const [campsQ, msgsQ, convsQ] = await Promise.all([
      supabase.schema('whatsapp_hub')
        .from('campaigns')
        .select('id, name, status, total_contacts, sent, delivered, read, replied, failed, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.schema('whatsapp_hub')
        .from('messages')
        .select('direction, created_at')
        .gte('created_at', sinceIso),
      supabase.schema('whatsapp_hub')
        .from('conversations')
        .select('status'),
    ]);

    if (campsQ.error || msgsQ.error || convsQ.error) {
      setError(
        campsQ.error?.message ?? msgsQ.error?.message ?? convsQ.error?.message ?? 'Falha',
      );
      setLoading(false);
      return;
    }

    setCampaigns((campsQ.data ?? []) as CampaignAgg[]);

    // Bucket messages per YYYY-MM-DD.
    const bucket = new Map<string, { inbound: number; outbound: number }>();
    for (const row of (msgsQ.data ?? []) as Array<{ direction: string; created_at: string }>) {
      const day = row.created_at.slice(0, 10);
      const slot = bucket.get(day) ?? { inbound: 0, outbound: 0 };
      if (row.direction === 'inbound') slot.inbound++;
      else slot.outbound++;
      bucket.set(day, slot);
    }
    // Fill every day in the period so the chart is dense rather than gappy.
    const days: VolumeByDay[] = [];
    for (let d = 0; d < periodDays(period); d++) {
      const dt = new Date();
      dt.setDate(dt.getDate() - (periodDays(period) - 1 - d));
      const day = dt.toISOString().slice(0, 10);
      const slot = bucket.get(day) ?? { inbound: 0, outbound: 0 };
      days.push({ day, inbound: slot.inbound, outbound: slot.outbound });
    }
    setVolumeByDay(days);

    // Conversation status distribution (all-time snapshot is fine here).
    const dist: ConversationStatusDistribution = { ai_active: 0, human_active: 0, closed: 0, total: 0 };
    for (const row of (convsQ.data ?? []) as Array<{ status: string }>) {
      if (row.status === 'ai_active') dist.ai_active++;
      else if (row.status === 'human_active') dist.human_active++;
      else if (row.status === 'closed') dist.closed++;
      dist.total++;
    }
    setConversationStatus(dist);

    setLoading(false);
  }, [userId, period]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totals = useMemo(() => {
    const acc = campaigns.reduce(
      (a, c) => ({
        total_contacts: a.total_contacts + (c.total_contacts ?? 0),
        sent: a.sent + (c.sent ?? 0),
        delivered: a.delivered + (c.delivered ?? 0),
        read: a.read + (c.read ?? 0),
        replied: a.replied + (c.replied ?? 0),
        failed: a.failed + (c.failed ?? 0),
      }),
      { total_contacts: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },
    );
    const deliveryRate = acc.sent > 0 ? (acc.delivered / acc.sent) * 100 : 0;
    const readRate = acc.delivered > 0 ? (acc.read / acc.delivered) * 100 : 0;
    const replyRate = acc.delivered > 0 ? (acc.replied / acc.delivered) * 100 : 0;
    return { ...acc, deliveryRate, readRate, replyRate };
  }, [campaigns]);

  return {
    loading,
    error,
    reload,
    period,
    setPeriod,
    totals,
    campaigns,
    volumeByDay,
    conversationStatus,
  };
}
