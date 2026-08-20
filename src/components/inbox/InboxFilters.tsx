// ============================================================================
// InboxFilters — caixa de filtros do inbox no mesmo padrão do funil comercial:
// botão "Filtros" (com contador) + seletor de ordenação, abrindo um grid de
// campos num popover. Só campos que se aplicam à conversa (sem campos de deal).
// A filtragem/ordenação é 100% client-side (ver inbox-filters.ts).
//
// O painel abre num portal no <body> porque o ancestral `.glass-card`
// (backdrop-filter + overflow-hidden) recorta popovers e a coluna da lista é
// estreita (300px) — o portal deixa o grid respirar.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, ChevronDown, Filter, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import type { Tag } from '@/types/crm';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  INBOX_SORT_LABEL,
  type Atendente,
  type ChannelFilter,
  type InboxFilterState,
  type InboxSort,
  type JanelaFilter,
  type StatusBucket,
  type TipoFilter,
} from './inbox-filters';

interface Props {
  filters: InboxFilterState;
  onChange: (next: InboxFilterState) => void;
  sort: InboxSort;
  onSortChange: (next: InboxSort) => void;
  operators: Operator[];
  tags: Tag[];
}

const inputCls =
  'w-full rounded-md border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls =
  'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

function DateRange({
  de,
  ate,
  onDe,
  onAte,
}: {
  de: string;
  ate: string;
  onDe: (v: string) => void;
  onAte: (v: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <input type="date" value={de} onChange={(e) => onDe(e.target.value)} className={`${inputCls} min-w-0`} />
      <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">–</span>
      <input type="date" value={ate} onChange={(e) => onAte(e.target.value)} className={`${inputCls} min-w-0`} />
    </div>
  );
}

// Chip pequeno para eixos multi-valor (Atendente, Status).
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-xs font-semibold border transition-colors',
        active
          ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.15)] text-[var(--color-text-primary)]'
          : 'border-[rgba(59,130,246,0.15)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[rgba(59,130,246,0.35)]',
      )}
    >
      {children}
    </button>
  );
}

// Dropdown de seleção múltipla (tags), idêntico ao do funil.
function MultiSelect({
  placeholder,
  options,
  selected,
  onChange,
}: {
  placeholder: string;
  options: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const toggleId = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${inputCls} flex items-center justify-between text-left`}
      >
        <span className={selected.length ? '' : 'text-[var(--color-text-secondary)]'}>
          {selected.length ? `${selected.length} selecionada(s)` : placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </button>
      {open && (
        <div className="absolute z-[60] mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-1 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-[var(--color-text-secondary)]">Nenhuma opção</div>
          )}
          {options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggleId(o.id)}
                className="accent-[var(--accent-primary)]"
              />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const CHANNEL_OPTS: { v: ChannelFilter; label: string }[] = [
  { v: 'all', label: 'Todos' },
  { v: 'whatsapp', label: 'WhatsApp' },
  { v: 'instagram', label: 'Instagram' },
  { v: 'uazapi', label: 'Uazapi' },
];
const ATENDENTE_OPTS: { v: Atendente; label: string }[] = [
  { v: 'ia', label: 'IA' },
  { v: 'humano', label: 'Humano' },
];
const STATUS_OPTS: { v: StatusBucket; label: string }[] = [
  { v: 'abertas', label: 'Abertas' },
  { v: 'fechadas', label: 'Fechadas' },
  { v: 'arquivadas', label: 'Arquivadas' },
];
const TIPO_OPTS: { v: TipoFilter; label: string }[] = [
  { v: 'any', label: 'Todos' },
  { v: 'lead', label: 'Lead' },
  { v: 'cliente', label: 'Cliente' },
];
const JANELA_OPTS: { v: JanelaFilter; label: string }[] = [
  { v: 'any', label: 'Qualquer' },
  { v: 'dentro', label: 'Dentro de 24h' },
  { v: 'fora', label: 'Fora de 24h' },
];

export function InboxFilters({ filters, onChange, sort, onSortChange, operators, tags }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const count = activeFilterCount(filters);

  // Reposiciona o popover a partir do retângulo do botão (portal no body).
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      // Ancora pela ESQUERDA do botão e trava dentro da viewport (o botão fica
      // na coluna estreita à esquerda; ancorar pela direita jogava o painel de
      // 34rem pra fora da tela).
      const panelW = Math.min(544, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - panelW - 8));
      setAnchor({ top: r.bottom + 8, left });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // Fecha ao clicar fora (considera o botão e o painel no portal).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const set = <K extends keyof InboxFilterState>(k: K, v: InboxFilterState[K]) =>
    onChange({ ...filters, [k]: v });

  const panel = (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between sm:hidden">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">Filtros</div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Fechar filtros"
          className="h-9 w-9 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-white/5"
        >
          <X className="h-4.5 w-4.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <input value={filters.nome} onChange={(e) => set('nome', e.target.value)} placeholder="Nome do lead" className={inputCls} />
        </Field>
        <Field label="Email">
          <input value={filters.email} onChange={(e) => set('email', e.target.value)} placeholder="email@..." className={inputCls} />
        </Field>
        <Field label="Telefone">
          <input value={filters.telefone} onChange={(e) => set('telefone', e.target.value)} placeholder="Somente números" className={inputCls} />
        </Field>
        <Field label="Empresa">
          <input value={filters.empresa} onChange={(e) => set('empresa', e.target.value)} placeholder="Nome da empresa" className={inputCls} />
        </Field>

        <Field label="Última interação">
          <DateRange
            de={filters.interacaoDe}
            ate={filters.interacaoAte}
            onDe={(v) => set('interacaoDe', v)}
            onAte={(v) => set('interacaoAte', v)}
          />
        </Field>
        <Field label="Tags">
          <MultiSelect
            placeholder="Todas"
            options={tags}
            selected={filters.tagIds}
            onChange={(ids) => set('tagIds', ids)}
          />
        </Field>

        <Field label="Canal">
          <select
            value={filters.channel}
            onChange={(e) => set('channel', e.target.value as ChannelFilter)}
            className={inputCls}
          >
            {CHANNEL_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Cliente / Lead">
          <select
            value={filters.tipo}
            onChange={(e) => set('tipo', e.target.value as TipoFilter)}
            className={inputCls}
          >
            {TIPO_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Atribuído a">
          <select
            value={filters.assigned}
            onChange={(e) => set('assigned', e.target.value)}
            className={inputCls}
          >
            <option value="any">Qualquer</option>
            <option value="unassigned">Não atribuído</option>
            {operators.map((o) => (
              <option key={o.user_id} value={o.user_id}>{operatorLabel(o)}</option>
            ))}
          </select>
        </Field>
        <Field label="Janela de 24h">
          <select
            value={filters.janela}
            onChange={(e) => set('janela', e.target.value as JanelaFilter)}
            className={inputCls}
          >
            {JANELA_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Atendente">
          <div className="flex flex-wrap gap-1.5">
            {ATENDENTE_OPTS.map((o) => (
              <Chip
                key={o.v}
                active={filters.atendente.includes(o.v)}
                onClick={() => set('atendente', toggle(filters.atendente, o.v))}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Status">
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTS.map((o) => (
              <Chip
                key={o.v}
                active={filters.status.includes(o.v)}
                onClick={() => set('status', toggle(filters.status, o.v))}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Field>
      </div>

      {count > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS })}
            className="inline-flex items-center gap-1 rounded-md border border-[rgba(59,130,246,0.2)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3 w-3" /> Limpar filtros
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex items-center gap-2" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
          count > 0
            ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.12)] text-[var(--color-text-primary)]'
            : 'border-[rgba(59,130,246,0.2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
        )}
      >
        <Filter className="h-3.5 w-3.5" />
        Filtros
        {count > 0 && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-primary)] px-1 text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </button>

      {/* Ordenação da lista (mesmo padrão do funil). */}
      <label className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(59,130,246,0.2)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--accent-primary)]">
        <ArrowUpDown className="h-3.5 w-3.5 opacity-70" />
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as InboxSort)}
          className="bg-transparent text-xs text-[var(--color-text-primary)] outline-none [&>option]:bg-[#0A0A0F]"
        >
          {(Object.keys(INBOX_SORT_LABEL) as InboxSort[]).map((s) => (
            <option key={s} value={s}>{INBOX_SORT_LABEL[s]}</option>
          ))}
        </select>
      </label>

      {open &&
        createPortal(
          <>
            {/* Desktop: popover ancorado. Mobile: bottom-sheet com overlay. */}
            <div
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm sm:hidden"
              onClick={() => setOpen(false)}
            />
            <div
              ref={panelRef}
              style={
                anchor
                  ? ({ '--pop-top': `${anchor.top}px`, '--pop-left': `${anchor.left}px` } as React.CSSProperties)
                  : undefined
              }
              className={cn(
                'z-50 bg-[#0F1223] border border-[rgba(59,130,246,0.25)] shadow-[0_0_40px_rgba(0,0,0,0.6)]',
                'fixed inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl',
                'sm:inset-x-auto sm:bottom-auto sm:w-[34rem] sm:max-w-[92vw] sm:rounded-xl',
                'sm:top-[var(--pop-top)] sm:left-[var(--pop-left)]',
              )}
            >
              {panel}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
