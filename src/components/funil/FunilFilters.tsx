// ============================================================================
// FunilFilters — painel de filtros + seletor de ordenação do board do funil.
// Filtragem 100% client-side sobre os deals já carregados no board.
// A lógica pura (filtros/ordenação) vive em funilFilterLogic.ts.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, ChevronDown, Filter, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import type { Tag } from '@/types/crm';
import {
  EMPTY_FILTERS, FUNIL_SORT_LABEL,
  type FunilFilterState, type FunilSort,
  countActiveFilters,
} from './funilFilterLogic';

export {
  applyFunilFilters, countActiveFilters, sortFunilDeals, EMPTY_FILTERS, FUNIL_SORT_LABEL,
} from './funilFilterLogic';
export type { FunilFilterState, FunilSort, ContactConvInfo } from './funilFilterLogic';

// ---- UI ---------------------------------------------------------------------

const inputCls =
  'w-full rounded-md border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

function DateRange({ de, ate, onDe, onAte }: { de: string; ate: string; onDe: (v: string) => void; onAte: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <input type="date" value={de} onChange={(e) => onDe(e.target.value)} className={inputCls} />
      <span className="text-xs text-[var(--color-text-secondary)]">–</span>
      <input type="date" value={ate} onChange={(e) => onAte(e.target.value)} className={inputCls} />
    </div>
  );
}

// Dropdown de seleção múltipla (produtos / tags).
function MultiSelect({
  placeholder, options, selected, onChange,
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

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`${inputCls} flex items-center justify-between text-left`}>
        <span className={selected.length ? '' : 'text-[var(--color-text-secondary)]'}>
          {selected.length ? `${selected.length} selecionado(s)` : placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-1 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-[var(--color-text-secondary)]">Nenhuma opção</div>
          )}
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-white/5">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="accent-[var(--accent-primary)]" />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function FunilFilters({
  filters, onChange, sort, onSortChange,
}: {
  filters: FunilFilterState;
  onChange: (f: FunilFilterState) => void;
  sort: FunilSort;
  onSortChange: (s: FunilSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const active = countActiveFilters(filters);

  useEffect(() => {
    const supabase = getSupabase();
    void supabase.from('tags').select('id, name, color').order('name')
      .then(({ data }) => setTags((data ?? []) as Tag[]));
    void supabase.from('products').select('id, name').order('name')
      .then(({ data }) => setProducts((data ?? []) as { id: string; name: string }[]));
  }, []);

  const set = <K extends keyof FunilFilterState>(k: K, v: FunilFilterState[K]) =>
    onChange({ ...filters, [k]: v });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.25)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)]"
        >
          <Filter className="h-4 w-4" /> Filtros
          {active > 0 && (
            <span className="rounded-full bg-[var(--accent-primary)] px-1.5 py-0.5 text-[10px] font-bold text-white">{active}</span>
          )}
        </button>

        {/* Ordenação dos cards dentro de cada etapa */}
        <label className="inline-flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.25)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)]">
          <ArrowUpDown className="h-4 w-4 opacity-70" />
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as FunilSort)}
            className="bg-transparent text-sm text-[var(--color-text-primary)] outline-none [&>option]:bg-[#0A0A0F]"
          >
            {(Object.keys(FUNIL_SORT_LABEL) as FunilSort[]).map((s) => (
              <option key={s} value={s}>{FUNIL_SORT_LABEL[s]}</option>
            ))}
          </select>
        </label>
      </div>

      {open && (
        <div className="glass-card mt-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

            <Field label="Data de compra">
              <DateRange de={filters.compraDe} ate={filters.compraAte} onDe={(v) => set('compraDe', v)} onAte={(v) => set('compraAte', v)} />
            </Field>
            <Field label="Última interação">
              <DateRange de={filters.interacaoDe} ate={filters.interacaoAte} onDe={(v) => set('interacaoDe', v)} onAte={(v) => set('interacaoAte', v)} />
            </Field>
            <Field label="Próxima ação">
              <DateRange de={filters.proximaAcaoDe} ate={filters.proximaAcaoAte} onDe={(v) => set('proximaAcaoDe', v)} onAte={(v) => set('proximaAcaoAte', v)} />
            </Field>
            <Field label="Valor do negócio (R$)">
              <div className="flex items-center gap-1">
                <input type="number" step="0.01" value={filters.valorMin} onChange={(e) => set('valorMin', e.target.value)} placeholder="Mín" className={inputCls} />
                <span className="text-xs text-[var(--color-text-secondary)]">–</span>
                <input type="number" step="0.01" value={filters.valorMax} onChange={(e) => set('valorMax', e.target.value)} placeholder="Máx" className={inputCls} />
              </div>
            </Field>

            <Field label="Tags">
              <MultiSelect placeholder="Todas" options={tags} selected={filters.tagIds} onChange={(ids) => set('tagIds', ids)} />
            </Field>
            <Field label="Produto">
              <MultiSelect placeholder="Todos" options={products} selected={filters.productIds} onChange={(ids) => set('productIds', ids)} />
            </Field>
            <Field label="Temperatura">
              <select value={filters.temperatura} onChange={(e) => set('temperatura', e.target.value as FunilFilterState['temperatura'])} className={inputCls}>
                <option value="">Todas</option>
                <option value="Frio">Frio</option>
                <option value="Morno">Morno</option>
                <option value="Quente">Quente</option>
              </select>
            </Field>
            <Field label="Cliente / Lead">
              <select value={filters.leadType} onChange={(e) => set('leadType', e.target.value as FunilFilterState['leadType'])} className={inputCls}>
                <option value="">Todos</option>
                <option value="Lead">Lead</option>
                <option value="Cliente">Cliente</option>
              </select>
            </Field>

            <Field label="Origem">
              <select value={filters.origem} onChange={(e) => set('origem', e.target.value as FunilFilterState['origem'])} className={inputCls}>
                <option value="">Todas</option>
                <option value="organico">Orgânico</option>
                <option value="meta_ads">Meta Ads</option>
                <option value="google_ads">Google Ads</option>
                <option value="linkedin_ads">LinkedIn Ads</option>
              </select>
            </Field>
            <Field label="Canal de comunicação">
              <select value={filters.canal} onChange={(e) => set('canal', e.target.value as FunilFilterState['canal'])} className={inputCls}>
                <option value="">Todos</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="instagram">Instagram</option>
                <option value="uazapi">Uazapi</option>
              </select>
            </Field>
          </div>

          {active > 0 && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => onChange(EMPTY_FILTERS)}
                className="inline-flex items-center gap-1 rounded-md border border-[rgba(59,130,246,0.2)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
              >
                <X className="h-3 w-3" /> Limpar filtros
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
