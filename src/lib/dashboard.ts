// Registry de widgets e utilidades de período do Dashboard de vendas (Módulo 3).

export type WidgetKey =
  | 'vendas_ganhas'
  | 'oportunidades_perdidas'
  | 'ranking_vendedores'
  | 'forecast'
  | 'tempo_primeira_resposta'
  | 'tempo_conclusao'
  | 'origem_trafego'
  | 'origem_canal'
  | 'origem_campanha'
  | 'origem_anuncios'
  | 'origem_posts_organicos'
  | 'conversao_campanhas'
  | 'conversao_anuncios'
  | 'conversao_posts';

export interface WidgetDef {
  key: WidgetKey;
  label: string;
  group: 'Vendas' | 'Anúncios' | 'Atendimento' | 'Origem' | 'Conversão';
  // Widgets de origem dependem dos UTMs (Módulo 4) — podem ficar vazios até haver dados.
  needsUtm?: boolean;
}

// Ordem = posição default no grid.
export const WIDGETS: WidgetDef[] = [
  { key: 'vendas_ganhas', label: 'Vendas ganhas', group: 'Vendas' },
  { key: 'oportunidades_perdidas', label: 'Oportunidades perdidas', group: 'Vendas' },
  { key: 'ranking_vendedores', label: 'Ranking de vendedores', group: 'Vendas' },
  { key: 'forecast', label: 'Forecast', group: 'Vendas' },
  { key: 'tempo_primeira_resposta', label: 'Tempo médio de 1ª resposta', group: 'Atendimento' },
  { key: 'tempo_conclusao', label: 'Tempo médio para concluir venda', group: 'Atendimento' },
  { key: 'origem_trafego', label: '% Origem do tráfego', group: 'Origem', needsUtm: true },
  { key: 'origem_canal', label: '% Canal de origem', group: 'Origem', needsUtm: true },
  { key: 'origem_campanha', label: '% Campanha de origem', group: 'Origem', needsUtm: true },
  { key: 'origem_anuncios', label: '% Anúncios de origem', group: 'Origem', needsUtm: true },
  { key: 'origem_posts_organicos', label: '% Posts orgânicos de origem', group: 'Origem', needsUtm: true },
  { key: 'conversao_campanhas', label: 'Campanhas de maior conversão', group: 'Conversão', needsUtm: true },
  { key: 'conversao_anuncios', label: 'Anúncios de maior conversão', group: 'Conversão', needsUtm: true },
  { key: 'conversao_posts', label: 'Posts de maior conversão', group: 'Conversão', needsUtm: true },
];

export const WIDGET_LABEL: Record<WidgetKey, string> = Object.fromEntries(
  WIDGETS.map((w) => [w.key, w.label]),
) as Record<WidgetKey, string>;

export type PeriodKey = 'today' | 'yesterday' | 'this_week' | 'last_week' | '1d' | '7d' | '15d' | '30d' | '60d' | '90d' | 'this_month' | 'last_month' | 'custom';

export const PERIOD_PRESETS: { key: Exclude<PeriodKey, 'custom'>; label: string; days: number }[] = [
  { key: 'today', label: 'Hoje', days: 0 },
  { key: 'yesterday', label: 'Ontem', days: 0 },
  { key: 'this_week', label: 'Essa semana', days: 0 },
  { key: 'last_week', label: 'Semana anterior', days: 0 },
  { key: '1d', label: '1d', days: 1 },
  { key: '7d', label: '7d', days: 7 },
  { key: '15d', label: '15d', days: 15 },
  { key: '30d', label: '30d', days: 30 },
  { key: '60d', label: '60d', days: 60 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'this_month', label: 'Este mês', days: 0 },
  { key: 'last_month', label: 'Mês anterior', days: 0 },
];

export interface PeriodRange {
  from: Date;
  to: Date;
}

// Resolve o intervalo a partir do preset (últimos N dias até agora) ou custom.
export function periodRange(key: PeriodKey, customFrom?: string, customTo?: string): PeriodRange {
  if (key === 'custom' && customFrom && customTo) {
    const from = new Date(customFrom + 'T00:00:00');
    const to = new Date(customTo + 'T23:59:59');
    return { from, to };
  }
  if (key === 'today') {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from, to: now };
  }
  if (key === 'yesterday') {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
    return { from, to };
  }
  if (key === 'this_week') {
    // Semana começa no domingo (getDay() === 0).
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    return { from, to: now };
  }
  if (key === 'last_week') {
    // Domingo a sábado da semana anterior.
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 7);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 1, 23, 59, 59);
    return { from, to };
  }
  if (key === 'this_month') {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = now;
    return { from, to };
  }
  if (key === 'last_month') {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { from, to };
  }
  const preset = PERIOD_PRESETS.find((p) => p.key === key) ?? PERIOD_PRESETS[1];
  const to = new Date();
  const from = new Date(to.getTime() - preset.days * 24 * 60 * 60 * 1000);
  return { from, to };
}

export function inRange(iso: string | null, r: PeriodRange): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= r.from.getTime() && t <= r.to.getTime();
}

// Formata uma duração (ms) em texto curto pt-BR (min / h / d).
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const min = ms / 60000;
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

// BRL com centavos (para CAC/ticket, onde arredondar para inteiro engana).
export const brl2 = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });

// Percentual pt-BR com 1 casa: 12.5 → "12,5%". null → "—".
export function formatPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

// Canais normalizados → rótulo legível (para os gráficos de origem).
export const ORIGIN_CHANNEL_LABEL: Record<string, string> = {
  google: 'Google',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  meta_ads: 'Meta Ads',
  instagram_ads: 'Instagram Ads',
  facebook_ads: 'Facebook Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  outro: 'Outro',
};

export const TRAFFIC_LABEL: Record<string, string> = {
  organico: 'Orgânico',
  pago: 'Pago',
  manual: 'Manual',
};
