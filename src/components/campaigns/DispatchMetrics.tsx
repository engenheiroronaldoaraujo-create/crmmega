import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts';
import { BarChart3, CheckCheck, Eye, MessageSquare, Send, Smartphone } from 'lucide-react';
import { useDashboardMetrics, type DashboardPeriod } from '@/hooks/useDashboardMetrics';
import { useNumberStatus } from '@/hooks/useNumberStatus';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';

const PERIODS: { value: DashboardPeriod; label: string }[] = [
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '90d', label: '90 dias' },
];

// Recharts default colors don't mix with the dark glass theme; we hand-pick
// palette slots that echo the sidebar / status chips used elsewhere.
const CHART_BLUE = '#3B82F6';
const CHART_GREEN = '#22C55E';
const CHART_AMBER = '#F59E0B';
const CHART_ROSE = '#EF4444';
const CHART_GRAY = '#64748B';

// Métricas de disparo WhatsApp — antes moravam no Dashboard; agora vivem na
// aba "Métricas" de Campanhas (Módulo 2). A lógica (hooks) permanece intacta.
export function DispatchMetrics() {
  const {
    loading,
    error,
    reload,
    period,
    setPeriod,
    totals,
    campaigns,
    volumeByDay,
    conversationStatus,
  } = useDashboardMetrics();

  const { status: numberStatus } = useNumberStatus();

  const topCampaigns = useMemo(() => campaigns.slice(0, 8).reverse(), [campaigns]);

  const statusSlices = useMemo(
    () => [
      { name: 'IA', value: conversationStatus.ai_active, fill: CHART_BLUE },
      { name: 'Humano', value: conversationStatus.human_active, fill: CHART_GREEN },
      { name: 'Fechadas', value: conversationStatus.closed, fill: CHART_GRAY },
    ],
    [conversationStatus],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Disparo WhatsApp</div>
            <h2 className="text-xl font-bold text-display">Métricas de disparo</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Últimos {period === '7d' ? '7' : period === '30d' ? '30' : '90'} dias ·{' '}
              {totals.sent.toLocaleString('pt-BR')} mensagens enviadas
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-[rgba(59,130,246,0.12)] p-1 bg-white/[0.02]">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={
                period === p.value
                  ? 'rounded-md px-3 py-1 text-xs font-semibold bg-[var(--accent-primary)] text-white'
                  : 'rounded-md px-3 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}

      {/* Saúde do número WhatsApp (Zernio · number-info) */}
      {numberStatus && (
        <div className="glass-card p-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl glass-card flex items-center justify-center">
                <Smartphone className="h-4 w-4 text-[var(--accent-primary)]" />
              </div>
              <div>
                <div className="text-label">WhatsApp</div>
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {numberStatus.number?.display_phone_number ?? 'Não conectado'}
                  {numberStatus.number?.verified_name && (
                    <span className="ml-2 font-normal text-[var(--color-text-secondary)]">
                      {numberStatus.number.verified_name}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {numberStatus.connected && (
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ['Tier', numberStatus.number?.messaging_limit_tier],
                  ['Qualidade', numberStatus.number?.quality_rating],
                  ['Saúde', numberStatus.number?.health_status],
                ]
                  .filter(([, v]) => v && String(v).toUpperCase() !== 'UNKNOWN')
                  .map(([label, v]) => (
                    <span
                      key={label}
                      className="rounded-full border border-[rgba(59,130,246,0.2)] bg-white/[0.02] px-3 py-1 text-[11px] text-[var(--color-text-secondary)]"
                    >
                      {label}: <span className="font-mono text-[var(--color-text-primary)]">{v}</span>
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          icon={<Send className="h-4 w-4 text-[var(--accent-primary)]" />}
          label="Enviadas"
          value={totals.sent}
          subtitle={`${totals.total_contacts.toLocaleString('pt-BR')} destinatários totais`}
        />
        <MetricCard
          icon={<CheckCheck className="h-4 w-4 text-[var(--color-success)]" />}
          label="Taxa de entrega"
          value={`${totals.deliveryRate.toFixed(1)}%`}
          subtitle={`${totals.delivered.toLocaleString('pt-BR')} entregues`}
          color="success"
        />
        <MetricCard
          icon={<Eye className="h-4 w-4 text-[#A78BFA]" />}
          label="Taxa de leitura"
          value={`${totals.readRate.toFixed(1)}%`}
          subtitle={`${totals.read.toLocaleString('pt-BR')} lidas`}
        />
        <MetricCard
          icon={<MessageSquare className="h-4 w-4 text-[#FBBF24]" />}
          label="Taxa de resposta"
          value={`${totals.replyRate.toFixed(1)}%`}
          subtitle={`${totals.replied.toLocaleString('pt-BR')} respondidas`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Volume por dia */}
        <div className="glass-card p-5 lg:col-span-2">
          <div className="mb-3">
            <div className="text-label">Volume por dia</div>
            <div className="text-sm text-[var(--color-text-secondary)]">
              Inbound (verde) vs outbound (azul) no período
            </div>
          </div>
          <div className="h-64">
            {loading ? (
              <ChartSkeleton />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={volumeByDay} margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(59,130,246,0.08)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: '#94A3B8' }}
                    tickFormatter={(d) => (typeof d === 'string' ? d.slice(5) : '')}
                    stroke="rgba(59,130,246,0.2)"
                  />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} stroke="rgba(59,130,246,0.2)" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(15,18,35,0.95)',
                      border: '1px solid rgba(59,130,246,0.25)',
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: '#F8FAFC' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="outbound"
                    name="Enviadas"
                    stroke={CHART_BLUE}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="inbound"
                    name="Recebidas"
                    stroke={CHART_GREEN}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Donut de conversas */}
        <div className="glass-card p-5">
          <div className="mb-3">
            <div className="text-label">Conversas</div>
            <div className="text-sm text-[var(--color-text-secondary)]">
              {conversationStatus.total} total
            </div>
          </div>
          <div className="h-64 flex items-center justify-center">
            {loading ? (
              <ChartSkeleton />
            ) : conversationStatus.total === 0 ? (
              <div className="text-xs text-[var(--color-text-secondary)] opacity-60">
                Sem conversas ainda.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusSlices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={85}
                    stroke="none"
                    paddingAngle={2}
                  >
                    {statusSlices.map((s, i) => (
                      <Cell key={i} fill={s.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(15,18,35,0.95)',
                      border: '1px solid rgba(59,130,246,0.25)',
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Barras por campanha */}
      <div className="glass-card p-5">
        <div className="mb-3">
          <div className="text-label">Performance por campanha</div>
          <div className="text-sm text-[var(--color-text-secondary)]">
            Top {topCampaigns.length} mais recentes
          </div>
        </div>
        <div className="h-80">
          {loading ? (
            <ChartSkeleton />
          ) : topCampaigns.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-secondary)] opacity-60">
              Nenhuma campanha no período.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={topCampaigns}
                layout="vertical"
                margin={{ top: 4, right: 10, left: 90, bottom: 0 }}
                barCategoryGap={10}
              >
                <CartesianGrid stroke="rgba(59,130,246,0.08)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#94A3B8' }} stroke="rgba(59,130,246,0.2)" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={90}
                  tick={{ fontSize: 11, fill: '#CBD5E1' }}
                  stroke="rgba(59,130,246,0.2)"
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(15,18,35,0.95)',
                    border: '1px solid rgba(59,130,246,0.25)',
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="sent" name="Enviadas" stackId="a" fill={CHART_BLUE} />
                <Bar dataKey="delivered" name="Entregues" stackId="a" fill={CHART_GREEN} />
                <Bar dataKey="read" name="Lidas" stackId="a" fill="#A78BFA" />
                <Bar dataKey="replied" name="Respondidas" stackId="a" fill={CHART_AMBER} />
                <Bar dataKey="failed" name="Falhas" stackId="a" fill={CHART_ROSE} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  subtitle,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle: string;
  color?: 'success' | 'primary';
}) {
  const valueClass =
    color === 'success'
      ? 'text-[var(--color-success)]'
      : 'text-[var(--color-text-primary)]';
  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 text-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-stat mt-2 ${valueClass}`}>
        {typeof value === 'number' ? value.toLocaleString('pt-BR') : value}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)] mt-1">{subtitle}</div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="text-label opacity-60">Carregando...</div>
    </div>
  );
}
