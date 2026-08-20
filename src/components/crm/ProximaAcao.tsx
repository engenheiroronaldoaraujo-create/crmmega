import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useScheduledActions } from '@/hooks/useScheduledActions';
import {
  CRM_ACTION_LABEL,
  CRM_ACTION_TYPES,
  DUE_TONE_STYLE,
  dueTone,
  type CrmActionType,
} from '@/types/crm';

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

const TONE_LABEL: Record<string, string> = { overdue: 'Atrasada', today: 'Hoje', future: 'Agendada' };

const fmtDue = (s: string | null) =>
  s
    ? new Date(s).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

interface ProximaAcaoProps {
  // Escopo por negócio (drawer do funil / inbox com negócio ativo).
  dealId?: string;
  // Escopo por contato (ficha): agrega ações de todos os negócios do contato.
  contactId?: string;
  // Negócios do contato — habilita o seletor de negócio no formulário (contexto contato).
  deals?: { id: string; title: string }[];
}

// Componente reutilizável "Próxima ação": lista ações agendadas (crm_activities
// com due_at, done=false), permite concluir/remover e agendar novas. Usado no
// drawer do funil, no painel da conversa (inbox) e na ficha do contato.
export function ProximaAcao({ dealId, contactId, deals }: ProximaAcaoProps) {
  const { actions, loading, schedule, complete, remove } = useScheduledActions({ dealId, contactId });

  const pending = useMemo(
    () =>
      actions
        .filter((a) => !a.done)
        .sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? '')),
    [actions],
  );

  const [text, setText] = useState('');
  const [dueLocal, setDueLocal] = useState('');
  const [type, setType] = useState<CrmActionType>('followup');
  const [dealChoice, setDealChoice] = useState('');
  const [busy, setBusy] = useState(false);

  const needsDealPicker = !dealId && Boolean(deals);
  const targetDeal = dealId ?? dealChoice;

  const onSchedule = async () => {
    if (!text.trim()) {
      toast.error('Descreva a ação.');
      return;
    }
    if (!dueLocal) {
      toast.error('Escolha data e hora.');
      return;
    }
    if (!targetDeal) {
      toast.error('Escolha o negócio.');
      return;
    }
    setBusy(true);
    try {
      await schedule({ dealId: targetDeal, text, dueAt: new Date(dueLocal).toISOString(), type });
      toast.success('Próxima ação agendada.');
      setText('');
      setDueLocal('');
      setType('followup');
    } catch (err) {
      toast.error('Falha ao agendar', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const onComplete = async (id: string) => {
    try {
      await complete(id);
      toast.success('Ação concluída.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const onRemove = async (id: string) => {
    try {
      await remove(id);
      toast.success('Ação removida.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  // Contexto de contato sem nenhum negócio: sem âncora possível.
  if (needsDealPicker && deals && deals.length === 0) {
    return (
      <section className="space-y-2">
        <div className="text-label flex items-center gap-1.5"><CalendarClock className="h-3 w-3" /> Próxima ação</div>
        <p className="text-sm text-[var(--color-text-secondary)] opacity-70">
          Crie um negócio para este contato para agendar a próxima ação.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="text-label flex items-center gap-1.5"><CalendarClock className="h-3 w-3" /> Próxima ação</div>

      {/* Lista de pendentes — a mais próxima em destaque */}
      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)] opacity-60">Carregando…</p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)] opacity-70">Nenhuma ação agendada.</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((a, i) => {
            const tone = dueTone(a.due_at);
            return (
              <li
                key={a.id}
                className={`rounded-lg border p-3 ${
                  i === 0
                    ? 'border-[rgba(59,130,246,0.4)] bg-[rgba(59,130,246,0.06)]'
                    : 'border-[rgba(59,130,246,0.12)] bg-white/[0.02]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${DUE_TONE_STYLE[tone]}`}>
                        {TONE_LABEL[tone]} · {fmtDue(a.due_at)}
                      </span>
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
                        {CRM_ACTION_LABEL[a.type as CrmActionType] ?? a.type}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--color-text-primary)]">
                      {a.body ?? a.title ?? '—'}
                    </p>
                    {a.dealTitle && (
                      <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]">
                        Negócio: {a.dealTitle}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void onComplete(a.id)}
                      title="Concluir"
                      aria-label="Concluir ação"
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[rgba(16,185,129,0.12)] hover:text-[var(--color-success)]"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => void onRemove(a.id)}
                      title="Remover"
                      aria-label="Remover ação"
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[rgba(239,68,68,0.12)] hover:text-[var(--color-error)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Formulário de agendamento */}
      <div className="space-y-2 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="O que fazer? (ex.: retornar ligação)"
          className={inputCls}
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            className={inputCls}
          />
          <select value={type} onChange={(e) => setType(e.target.value as CrmActionType)} className={inputCls}>
            {CRM_ACTION_TYPES.map((t) => (
              <option key={t} value={t}>{CRM_ACTION_LABEL[t]}</option>
            ))}
          </select>
        </div>
        {needsDealPicker && (
          <select value={dealChoice} onChange={(e) => setDealChoice(e.target.value)} className={inputCls}>
            <option value="">Negócio…</option>
            {(deals ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        )}
        <Button size="sm" onClick={() => void onSchedule()} disabled={busy} className="w-full justify-center">
          <Plus className="h-4 w-4" /> {busy ? 'Agendando…' : 'Agendar ação'}
        </Button>
      </div>
    </section>
  );
}
