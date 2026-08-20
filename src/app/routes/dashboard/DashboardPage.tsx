import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LayoutDashboard, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { useSalesDashboard } from '@/hooks/useSalesDashboard';
import { useDashboardPrefs } from '@/hooks/useDashboardPrefs';
import { useOperators } from '@/hooks/useOperators';
import { hasCosts, netRevenue, parseDecimal, useSalesCosts, type SalesCosts } from '@/hooks/useSalesCosts';
import { useAppUser } from '@/app/providers/AppUserProvider';
import {
  ORIGIN_CHANNEL_LABEL,
  PERIOD_PRESETS,
  TRAFFIC_LABEL,
  WIDGETS,
  periodRange,
  type PeriodKey,
  type WidgetKey,
} from '@/lib/dashboard';
import {
  DurationWidget,
  ForecastWidget,
  OriginBarsWidget,
  OriginDonutWidget,
  RankingWidget,
  SalesKpiWidget,
} from '@/components/dashboard/widgets';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { CredentialsBanner } from '@/components/CredentialsBanner';
import { cn } from '@/lib/utils';

const NO_UTM = 'Sem dados de rastreio ainda.';
const NO_WON_UTM = 'Nenhuma venda ganha com rastreio no período.';

function isPeriodKey(v: string | null): v is PeriodKey {
  return v === 'today' || v === 'yesterday' || v === 'this_week' || v === 'last_week' || v === '1d' || v === '7d' || v === '15d' || v === '30d' || v === '60d' || v === '90d' || v === 'this_month' || v === 'last_month' || v === 'custom';
}

export default function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const periodKey: PeriodKey = isPeriodKey(params.get('period')) ? (params.get('period') as PeriodKey) : '30d';
  const customFrom = params.get('from') ?? '';
  const customTo = params.get('to') ?? '';
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const range = useMemo(
    () => periodRange(periodKey, customFrom, customTo),
    [periodKey, customFrom, customTo],
  );

  const { metrics, loading, error, reload } = useSalesDashboard(range);
  const { visibleMap, toggle } = useDashboardPrefs();
  const { operators } = useOperators();
  const { role } = useAppUser();
  const { costs, save: saveCosts } = useSalesCosts();
  const [refreshing, setRefreshing] = useState(false);

  // Faturamento líquido em "Vendas ganhas": só quando há algum custo definido.
  const wonNet = useMemo(
    () => (hasCosts(costs) ? netRevenue(metrics.won.value, metrics.won.count, costs) : null),
    [costs, metrics.won.value, metrics.won.count],
  );

  // Recarrega as vendas no período atual.
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const ownerName = (id: string | null) => {
    if (!id) return 'Não atribuído';
    return operators.find((o) => o.user_id === id)?.email ?? 'Vendedor';
  };

  const setPeriod = (key: PeriodKey) => {
    const next = new URLSearchParams(params);
    next.set('period', key);
    if (key !== 'custom') {
      next.delete('from');
      next.delete('to');
    }
    setParams(next, { replace: true });
  };

  const setCustom = (which: 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params);
    next.set('period', 'custom');
    next.set(which, value);
    setParams(next, { replace: true });
  };

  const handleToggle = async (key: WidgetKey) => {
    const id = await toggle(key);
    if (id) toast.success('Preferência salva.', { description: `dashboard_preferences: ${id}` });
  };

  const show = (key: WidgetKey) => visibleMap[key] !== false;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <CredentialsBanner />
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <LayoutDashboard className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">Dashboard</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Vendas e atendimento</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-[rgba(59,130,246,0.2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => setCustomizeOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-[rgba(59,130,246,0.2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Personalizar dashboard
          </button>
        </div>
      </div>

      {/* Filtro de período (global) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-[rgba(59,130,246,0.12)] p-1 bg-white/[0.02]">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-semibold',
                periodKey === p.key
                  ? 'bg-[var(--accent-primary)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setPeriod('custom')}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-semibold',
              periodKey === 'custom'
                ? 'bg-[var(--accent-primary)] text-white'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            Personalizado
          </button>
        </div>
        {periodKey === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustom('from', e.target.value)}
              className="rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1 text-xs text-[var(--color-text-primary)]"
            />
            <span className="text-xs text-[var(--color-text-secondary)]">até</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustom('to', e.target.value)}
              className="rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1 text-xs text-[var(--color-text-primary)]"
            />
          </div>
        )}
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}

      {/* Painel de personalização */}
      {customizeOpen && (
        <div className="glass-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-label">Widgets exibidos</div>
            <button onClick={() => setCustomizeOpen(false)} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {WIDGETS.map((w) => (
              <label key={w.key} className="flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={show(w.key)}
                  onChange={() => void handleToggle(w.key)}
                  className="accent-[var(--accent-primary)] h-4 w-4"
                />
                <span className="text-sm text-[var(--color-text-primary)]">{w.label}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">{w.group}</span>
              </label>
            ))}
          </div>

          <SalesCostsForm costs={costs} canEdit={role === 'admin'} onSave={saveCosts} />
        </div>
      )}

      {loading ? (
        <div className="glass-card p-10 text-center text-label opacity-60">Carregando métricas...</div>
      ) : (
        <>
        {/* Fileira 1 — KPIs de vendas */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {show('vendas_ganhas') && (
            <SalesKpiWidget title="Vendas ganhas" count={metrics.won.count} value={metrics.won.value} series={metrics.won.series} color="#10B981" netValue={wonNet} />
          )}
          {show('oportunidades_perdidas') && (
            <SalesKpiWidget title="Oportunidades perdidas" count={metrics.lost.count} value={metrics.lost.value} series={metrics.lost.series} color="#EF4444" />
          )}
          {show('forecast') && <ForecastWidget value={metrics.forecast.value} openCount={metrics.forecast.openCount} />}
        </div>

        {/* Demais widgets */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {show('ranking_vendedores') && (
            <div className="md:col-span-2">
              <RankingWidget ranking={metrics.ranking} ownerName={ownerName} />
            </div>
          )}
          {show('tempo_primeira_resposta') && (
            <DurationWidget
              title="Tempo médio de 1ª resposta"
              subtitle="Do 1º contato do lead à 1ª resposta humana"
              avgMs={metrics.firstResponse.avgMs}
              byOwner={metrics.firstResponse.byOwner}
              ownerName={ownerName}
            />
          )}
          {show('tempo_conclusao') && (
            <DurationWidget
              title="Tempo médio para concluir venda"
              subtitle="Da criação do negócio até marcar ganho"
              avgMs={metrics.closeTime.avgMs}
              byOwner={metrics.closeTime.byOwner}
              ownerName={ownerName}
            />
          )}
          {show('origem_trafego') && (
            <OriginDonutWidget title="% Origem do tráfego" data={metrics.origin.traffic} labelMap={TRAFFIC_LABEL} emptyText={NO_UTM} />
          )}
          {show('origem_canal') && (
            <OriginBarsWidget title="% Canal de origem" data={metrics.origin.channel} labelMap={ORIGIN_CHANNEL_LABEL} emptyText={NO_UTM} />
          )}
          {show('origem_campanha') && (
            <OriginBarsWidget title="% Campanha de origem" data={metrics.origin.campaign} emptyText={NO_UTM} />
          )}
          {show('origem_anuncios') && (
            <OriginBarsWidget title="% Anúncios de origem" data={metrics.origin.ads} emptyText={NO_UTM} />
          )}
          {show('origem_posts_organicos') && (
            <OriginBarsWidget title="% Posts orgânicos de origem" data={metrics.origin.organicPosts} emptyText={NO_UTM} />
          )}
          {/* Conversão: mesmas dimensões, mas contando só os deals GANHOS no período */}
          {show('conversao_campanhas') && (
            <OriginBarsWidget title="Campanhas de maior conversão" data={metrics.conversion.campaigns} emptyText={NO_WON_UTM} unit="vendas" color="#10B981" />
          )}
          {show('conversao_anuncios') && (
            <OriginBarsWidget title="Anúncios de maior conversão" data={metrics.conversion.ads} emptyText={NO_WON_UTM} unit="vendas" color="#10B981" />
          )}
          {show('conversao_posts') && (
            <OriginBarsWidget title="Posts de maior conversão" data={metrics.conversion.organicPosts} emptyText={NO_WON_UTM} unit="vendas" color="#10B981" />
          )}
        </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faturamento líquido: custos abatidos do card "Vendas ganhas".
// Config da instância (app_settings.sales_costs) — escrita admin-only via RLS.
// ---------------------------------------------------------------------------
function SalesCostsForm({
  costs, canEdit, onSave,
}: {
  costs: SalesCosts;
  canEdit: boolean;
  onSave: (c: SalesCosts) => Promise<string | null>;
}) {
  const [checkout, setCheckout] = useState('');
  const [tax, setTax] = useState('');
  const [other, setOther] = useState('');
  const [otherKind, setOtherKind] = useState<SalesCosts['other_kind']>('fixed');
  const [saving, setSaving] = useState(false);

  // Sincroniza o form quando os custos carregam do banco.
  useEffect(() => {
    setCheckout(costs.checkout_pct ? String(costs.checkout_pct) : '');
    setTax(costs.tax_pct ? String(costs.tax_pct) : '');
    setOther(costs.other_value ? String(costs.other_value) : '');
    setOtherKind(costs.other_kind);
  }, [costs]);

  const inputCls =
    'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-50';
  const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

  const handleSave = async () => {
    setSaving(true);
    // parseDecimal aceita vírgula decimal ("4,99") — Number() puro viraria 0.
    const err = await onSave({
      checkout_pct: parseDecimal(checkout),
      tax_pct: parseDecimal(tax),
      other_value: parseDecimal(other),
      other_kind: otherKind,
    });
    setSaving(false);
    if (err) toast.error('Não foi possível salvar os custos.', { description: err });
    else toast.success('Custos salvos. "Vendas ganhas" agora exibe o faturamento líquido.');
  };

  return (
    <div className="mt-4 border-t border-[rgba(59,130,246,0.08)] pt-4">
      <div className="text-label mb-1">Faturamento líquido (Vendas ganhas)</div>
      <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
        Custos abatidos do valor bruto das vendas ganhas. Deixe em 0 para exibir só o bruto.
        {!canEdit && ' Somente administradores podem alterar.'}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <span className={labelCls}>Taxa do checkout (%)</span>
          <input type="number" min="0" step="0.01" placeholder="Ex.: 4,99" value={checkout} onChange={(e) => setCheckout(e.target.value)} disabled={!canEdit} className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Imposto (%)</span>
          <input type="number" min="0" step="0.01" placeholder="Ex.: 6" value={tax} onChange={(e) => setTax(e.target.value)} disabled={!canEdit} className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Outros custos por venda</span>
          <div className="flex items-center gap-1.5">
            <input type="number" min="0" step="0.01" placeholder="Ex.: 2,50" value={other} onChange={(e) => setOther(e.target.value)} disabled={!canEdit} className={inputCls} />
            <select
              value={otherKind}
              onChange={(e) => setOtherKind(e.target.value as SalesCosts['other_kind'])}
              disabled={!canEdit}
              className="rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-50 [&>option]:bg-[#0A0A0F]"
            >
              <option value="fixed">R$</option>
              <option value="pct">%</option>
            </select>
          </div>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canEdit || saving}
            className="w-full rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Salvando…' : 'Salvar custos'}
          </button>
        </div>
      </div>
    </div>
  );
}
