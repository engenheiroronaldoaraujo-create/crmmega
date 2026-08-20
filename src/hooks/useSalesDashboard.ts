import { useCallback, useEffect, useState } from 'react';
import { type PeriodRange } from '@/lib/dashboard';
import { getSupabase } from '@/lib/supabase';

export interface NameCount {
  name: string;
  value: number;
  count: number;
}
export interface DaySeriesPoint {
  day: string;
  value: number;
  count: number;
}
export interface OwnerAgg {
  owner_id: string | null;
  value: number;
  count: number;
}
export interface OwnerDuration {
  owner_id: string | null;
  ms: number | null;
  count: number;
}

export interface SalesMetrics {
  won: { count: number; value: number; series: DaySeriesPoint[] };
  lost: { count: number; value: number; series: DaySeriesPoint[]; reasons: NameCount[] };
  ranking: OwnerAgg[];
  forecast: { value: number; openCount: number };
  firstResponse: { avgMs: number | null; byOwner: OwnerDuration[] };
  closeTime: { avgMs: number | null; byOwner: OwnerDuration[] };
  origin: {
    hasData: boolean;
    traffic: NameCount[];
    channel: NameCount[];
    campaign: NameCount[];
    ads: NameCount[];
    organicPosts: NameCount[];
  };
  // Conversão: mesmas dimensões de origem, mas só sobre deals GANHOS no
  // período — quais campanhas/anúncios/posts realmente viraram venda.
  conversion: {
    campaigns: NameCount[];
    ads: NameCount[];
    organicPosts: NameCount[];
  };
}

const EMPTY_METRICS: SalesMetrics = {
  won: { count: 0, value: 0, series: [] },
  lost: { count: 0, value: 0, series: [], reasons: [] },
  ranking: [],
  forecast: { value: 0, openCount: 0 },
  firstResponse: { avgMs: null, byOwner: [] },
  closeTime: { avgMs: null, byOwner: [] },
  origin: { hasData: false, traffic: [], channel: [], campaign: [], ads: [], organicPosts: [] },
  conversion: { campaigns: [], ads: [], organicPosts: [] },
};

// ---- helpers de agregação (tudo derivado dos deals reais) ----

const dayKey = (iso: string) => iso.slice(0, 10);

// Série horária (00h–23h, horário local) para períodos de até 1 dia ("Hoje"/"1d").
function buildHourlySeries(range: PeriodRange, rows: { date: string | null; value: number }[]): DaySeriesPoint[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const hourKey = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const byHour = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const k = hourKey(new Date(r.date));
    const cur = byHour.get(k) ?? { value: 0, count: 0 };
    cur.value += r.value;
    cur.count += 1;
    byHour.set(k, cur);
  }
  // Cobre do 00h do dia inicial até 23h do dia final (dia completo no gráfico).
  const start = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate());
  const end = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23);
  const out: DaySeriesPoint[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 3600000) {
    const k = hourKey(new Date(t));
    const v = byHour.get(k) ?? { value: 0, count: 0 };
    out.push({ day: k, value: v.value, count: v.count });
  }
  return out;
}

// Série diária cobrindo todo o range, com value/count reais (0 onde não há).
function buildSeries(range: PeriodRange, rows: { date: string | null; value: number }[]): DaySeriesPoint[] {
  const dayMs = 86400000;
  if (range.to.getTime() - range.from.getTime() <= dayMs) {
    return buildHourlySeries(range, rows);
  }
  const start = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
  const days = Math.max(1, Math.round((range.to.getTime() - start.getTime()) / dayMs) + 1);
  const byDay = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const k = dayKey(r.date);
    const cur = byDay.get(k) ?? { value: 0, count: 0 };
    cur.value += r.value;
    cur.count += 1;
    byDay.set(k, cur);
  }
  const out: DaySeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const k = new Date(start.getTime() + i * dayMs).toISOString().slice(0, 10);
    const v = byDay.get(k) ?? { value: 0, count: 0 };
    out.push({ day: k, value: v.value, count: v.count });
  }
  return out;
}

// Agrupa por uma chave textual (name), somando value e contando.
function groupCount(rows: { key: string | null; value: number }[]): NameCount[] {
  const map = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    const name = (r.key ?? '').trim();
    if (!name) continue;
    const cur = map.get(name) ?? { value: 0, count: 0 };
    cur.value += r.value;
    cur.count += 1;
    map.set(name, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, value: v.value, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

interface DealRow {
  id: string;
  value: number | null;
  owner_id: string | null;
  created_at: string;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  first_contact_at: string | null;
  first_response_at: string | null;
  traffic_type: string | null;
  origin_channel: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
}

function ownerDurations(pairs: { owner_id: string | null; ms: number }[]): { avgMs: number | null; byOwner: OwnerDuration[] } {
  if (pairs.length === 0) return { avgMs: null, byOwner: [] };
  const avgMs = Math.round(pairs.reduce((s, p) => s + p.ms, 0) / pairs.length);
  const map = new Map<string, { sum: number; count: number }>();
  for (const p of pairs) {
    const k = p.owner_id ?? '__none__';
    const cur = map.get(k) ?? { sum: 0, count: 0 };
    cur.sum += p.ms;
    cur.count += 1;
    map.set(k, cur);
  }
  const byOwner: OwnerDuration[] = [...map.entries()].map(([k, v]) => ({
    owner_id: k === '__none__' ? null : k,
    ms: Math.round(v.sum / v.count),
    count: v.count,
  }));
  return { avgMs, byOwner };
}

function compute(range: PeriodRange, deals: DealRow[], stageProb: Map<string, number>, openDeals: { value: number | null; stage_id: string | null }[]): SalesMetrics {
  const fromISO = range.from.toISOString();
  const toISO = range.to.toISOString();
  const inRange = (iso: string | null) => !!iso && iso >= fromISO && iso <= toISO;

  // Ganhos (won_at no range).
  const won = deals.filter((d) => d.won_at && inRange(d.won_at));
  const wonValue = won.reduce((s, d) => s + Number(d.value ?? 0), 0);
  const wonSeries = buildSeries(range, won.map((d) => ({ date: d.won_at, value: Number(d.value ?? 0) })));

  // Perdidos (lost_at no range).
  const lost = deals.filter((d) => d.lost_at && inRange(d.lost_at));
  const lostValue = lost.reduce((s, d) => s + Number(d.value ?? 0), 0);
  const lostSeries = buildSeries(range, lost.map((d) => ({ date: d.lost_at, value: Number(d.value ?? 0) })));
  const reasons = groupCount(lost.map((d) => ({ key: d.lost_reason ?? 'Sem motivo', value: Number(d.value ?? 0) })));

  // Ranking por vendedor (ganhos).
  const rankMap = new Map<string, { value: number; count: number }>();
  for (const d of won) {
    const k = d.owner_id ?? '__none__';
    const cur = rankMap.get(k) ?? { value: 0, count: 0 };
    cur.value += Number(d.value ?? 0);
    cur.count += 1;
    rankMap.set(k, cur);
  }
  const ranking: OwnerAgg[] = [...rankMap.entries()]
    .map(([k, v]) => ({ owner_id: k === '__none__' ? null : k, value: v.value, count: v.count }))
    .sort((a, b) => b.value - a.value);

  // Forecast: negócios abertos ponderados pela probabilidade do estágio.
  const forecastValue = openDeals.reduce((s, d) => {
    const prob = (d.stage_id ? stageProb.get(d.stage_id) : 0) ?? 0;
    return s + Number(d.value ?? 0) * (prob / 100);
  }, 0);

  // Tempos (dos ganhos): 1ª resposta e conclusão.
  const frPairs = won
    .filter((d) => d.first_contact_at && d.first_response_at)
    .map((d) => ({ owner_id: d.owner_id, ms: new Date(d.first_response_at!).getTime() - new Date(d.first_contact_at!).getTime() }))
    .filter((p) => p.ms >= 0);
  const ctPairs = won
    .filter((d) => d.won_at)
    .map((d) => ({ owner_id: d.owner_id, ms: new Date(d.won_at!).getTime() - new Date(d.created_at).getTime() }))
    .filter((p) => p.ms >= 0);
  const firstResponse = ownerDurations(frPairs);
  const closeTime = ownerDurations(ctPairs);

  // Origem: distribuição dos deals criados no range.
  const created = deals.filter((d) => inRange(d.created_at));
  const traffic = groupCount(created.map((d) => ({ key: d.traffic_type, value: Number(d.value ?? 0) })));
  const channel = groupCount(created.map((d) => ({ key: d.origin_channel, value: Number(d.value ?? 0) })));
  const campaign = groupCount(created.map((d) => ({ key: d.utm_campaign, value: Number(d.value ?? 0) })));
  const ads = groupCount(created.filter((d) => d.traffic_type === 'pago').map((d) => ({ key: d.utm_content ?? d.utm_campaign, value: Number(d.value ?? 0) })));
  const organicPosts = groupCount(created.filter((d) => d.traffic_type === 'organico').map((d) => ({ key: d.utm_content, value: Number(d.value ?? 0) })));
  const hasData = traffic.length + channel.length + campaign.length + ads.length + organicPosts.length > 0;

  // Conversão: dimensões de origem calculadas só sobre os GANHOS do período.
  const wonCampaigns = groupCount(won.map((d) => ({ key: d.utm_campaign, value: Number(d.value ?? 0) })));
  const wonAds = groupCount(won.filter((d) => d.traffic_type === 'pago').map((d) => ({ key: d.utm_content ?? d.utm_campaign, value: Number(d.value ?? 0) })));
  const wonPosts = groupCount(won.filter((d) => d.traffic_type === 'organico').map((d) => ({ key: d.utm_content, value: Number(d.value ?? 0) })));

  return {
    won: { count: won.length, value: wonValue, series: wonSeries },
    lost: { count: lost.length, value: lostValue, series: lostSeries, reasons },
    ranking,
    forecast: { value: Math.round(forecastValue), openCount: openDeals.length },
    firstResponse,
    closeTime,
    origin: { hasData, traffic, channel, campaign, ads, organicPosts },
    conversion: { campaigns: wonCampaigns, ads: wonAds, organicPosts: wonPosts },
  };
}

export function useSalesDashboard(range: PeriodRange) {
  const [metrics, setMetrics] = useState<SalesMetrics>(EMPTY_METRICS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const fromISO = range.from.toISOString();
    const toISO = range.to.toISOString();

    // Deals relevantes ao período: criados, ganhos ou perdidos dentro do range.
    const cols =
      'id, value, owner_id, created_at, won_at, lost_at, lost_reason, first_contact_at, first_response_at, traffic_type, origin_channel, utm_campaign, utm_content';
    const [createdRes, wonRes, lostRes, openRes, stagesRes] = await Promise.all([
      supabase.from('deals').select(cols).gte('created_at', fromISO).lte('created_at', toISO),
      supabase.from('deals').select(cols).eq('status', 'won').gte('won_at', fromISO).lte('won_at', toISO),
      supabase.from('deals').select(cols).eq('status', 'lost').gte('lost_at', fromISO).lte('lost_at', toISO),
      supabase.from('deals').select('value, stage_id').eq('status', 'open'),
      supabase.from('stages').select('id, probability'),
    ]);

    const firstErr = createdRes.error || wonRes.error || lostRes.error || openRes.error || stagesRes.error;
    if (firstErr) {
      setError(firstErr.message);
      setMetrics(EMPTY_METRICS);
      setLoading(false);
      return;
    }

    // Dedup por união dos três conjuntos (um deal pode aparecer em mais de um).
    const byKey = new Map<string, DealRow>();
    for (const r of [
      ...((createdRes.data ?? []) as DealRow[]),
      ...((wonRes.data ?? []) as DealRow[]),
      ...((lostRes.data ?? []) as DealRow[]),
    ]) {
      byKey.set(r.id, r);
    }
    const deals = [...byKey.values()];
    const stageProb = new Map<string, number>(
      ((stagesRes.data ?? []) as { id: string; probability: number }[]).map((s) => [s.id, s.probability]),
    );
    const openDeals = (openRes.data ?? []) as { value: number | null; stage_id: string | null }[];

    setMetrics(compute(range, deals, stageProb, openDeals));
    setLoading(false);
  }, [range.from, range.to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { metrics, loading, error, reload };
}
