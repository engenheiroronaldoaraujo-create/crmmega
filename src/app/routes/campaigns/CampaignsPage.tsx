import { useSearchParams } from 'react-router-dom';
import { BarChart3, FileText, Link2, Megaphone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CampaignsList } from '@/components/campaigns/CampaignsList';
import { TemplatesList } from '@/components/campaigns/TemplatesList';
import { DispatchMetrics } from '@/components/campaigns/DispatchMetrics';
import { UtmBuilder } from '@/components/campaigns/UtmBuilder';
import { UtmChannelMap } from '@/components/campaigns/UtmChannelMap';

// Campanhas concentra as abas: lista de campanhas, templates (Módulo 1),
// métricas de disparo (Módulo 2) e o gerador de UTMs (Módulo 4). A aba UTMs
// reúne toda a configuração de parâmetros: gerador de URLs + mapa de canal
// (antes em Configurações). A aba ativa é sincronizada com ?tab= para
// redirects e links.
type TabId = 'campanhas' | 'templates' | 'metricas' | 'utms';

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

const TABS: TabDef[] = [
  { id: 'campanhas', label: 'Campanhas', icon: Megaphone, render: () => <CampaignsList /> },
  { id: 'templates', label: 'Templates', icon: FileText, render: () => <TemplatesList /> },
  { id: 'metricas', label: 'Métricas', icon: BarChart3, render: () => <DispatchMetrics /> },
  {
    id: 'utms',
    label: 'UTMs',
    icon: Link2,
    render: () => (
      <div className="space-y-6">
        <UtmBuilder />
        <UtmChannelMap />
      </div>
    ),
  },
];

function isTabId(v: string | null): v is TabId {
  return v === 'campanhas' || v === 'templates' || v === 'metricas' || v === 'utms';
}

export default function CampaignsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const active: TabId = isTabId(raw) ? raw : 'campanhas';
  const current = TABS.find((t) => t.id === active) ?? TABS[0];

  const selectTab = (id: TabId) => {
    // replace evita empilhar histórico a cada troca de aba.
    setParams(id === 'campanhas' ? {} : { tab: id }, { replace: true });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Megaphone className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <h1 className="text-2xl font-bold text-display">Campanhas</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Disparos em massa, templates da Meta e métricas de entrega
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[rgba(59,130,246,0.1)]">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-[var(--accent-primary)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>{current.render()}</div>
    </div>
  );
}
