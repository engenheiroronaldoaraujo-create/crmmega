import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitBranchPlus, Timer, Zap } from 'lucide-react';
import { FunnelAutomationsTab } from '@/components/automations/FunnelAutomationsTab';
import { FollowUpsTab } from '@/components/automations/FollowUpsTab';

// Automações: regras que rodam sozinhas — no Funil (lead entrou numa etapa →
// ações) e em Follow-ups (inatividade / sem compra / sem resposta → mensagem).
type TabId = 'funil' | 'followups';

export default function AutomationsPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>(() =>
    searchParams.get('tab') === 'followups' ? 'followups' : 'funil',
  );

  const tabs: { id: TabId; label: string; icon: typeof Zap }[] = [
    { id: 'funil', label: 'Funil', icon: GitBranchPlus },
    { id: 'followups', label: 'Follow-ups', icon: Timer },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Zap className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <h1 className="text-2xl font-bold text-display">Automações</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Regras automáticas no funil e follow-ups por tempo/condição.
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-[rgba(59,130,246,0.1)]">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
                tab === t.id
                  ? 'border-[var(--accent-primary)] text-[var(--accent-secondary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'funil' ? <FunnelAutomationsTab /> : <FollowUpsTab />}
    </div>
  );
}
