import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Phone, Mail, Building2, ChevronDown, MessageSquare, Plus, Check } from 'lucide-react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { useDealDetail } from '@/hooks/useDealDetail';
import { useOperators } from '@/hooks/useOperators';
import { ProximaAcao } from '@/components/crm/ProximaAcao';
import {
  CONTACT_SOURCE_LABEL,
  CUSTOM_FIELD_TYPE_LABEL,
  getDealOrigin,
  TEMPERATURE_STYLE,
  TRAFFIC_TYPE_STYLE,
  type CustomField,
  type CustomFieldType,
  type Deal,
  type LeadType,
  type Pipeline,
  type Stage,
  type Temperature,
} from '@/types/crm';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isE164ish = (v: string) => /^\+?\d{8,15}$/.test(v.replace(/[\s()-]/g, ''));

interface DealDrawerProps {
  deal: Deal;
  stages: Stage[];
  pipelines: Pipeline[];
  isAdmin: boolean;
  onClose: () => void;
  onStageChange: (dealId: string, stageId: string) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

export function DealDrawer({ deal, stages, pipelines, isAdmin, onClose, onStageChange, onChanged }: DealDrawerProps) {
  const detail = useDealDetail(deal);
  const { contact, fields, values, notes, products, tags, productCatalog, tagCatalog, loading, error } = detail;
  const { operators } = useOperators();
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [fieldModal, setFieldModal] = useState(false);
  const [stageId, setStageId] = useState(deal.stage_id ?? '');
  const [lostReasonOpen, setLostReasonOpen] = useState(false);
  const [lostReason, setLostReason] = useState(deal.lost_reason ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => setStageId(deal.stage_id ?? ''), [deal.stage_id]);

  const company = contact?.custom_fields && typeof contact.custom_fields.company === 'string' ? String(contact.custom_fields.company) : null;
  const origin = getDealOrigin(deal);

  const submitNote = async () => {
    if (!note.trim()) return;
    setSavingNote(true);
    await detail.addNote(note);
    setNote('');
    setSavingNote(false);
  };

  const changeStage = async (id: string) => {
    setStageId(id);
    await onStageChange(deal.id, id);
  };

  // Status manual do negócio (Módulo 3): won/lost preenchem won_at/lost_at via
  // trigger; perdido guarda o motivo. Reabrir volta para 'open' e limpa datas.
  const markWon = () => {
    const patch: Partial<Deal> = { status: 'won' };
    // Move automático para a etapa "Ganho" só quando o lead está no funil
    // padrão e a etapa (is_won) ainda existe; caso contrário, apenas o status
    // muda e o card fica onde está.
    const defaultPipeline = pipelines.find((p) => p.is_default);
    if (defaultPipeline && deal.pipeline_id === defaultPipeline.id) {
      const wonStage = stages.find((s) => s.is_won);
      if (wonStage && wonStage.id !== deal.stage_id) {
        patch.stage_id = wonStage.id;
        setStageId(wonStage.id);
      }
    }
    void saveDealField(patch, 'Marcado como ganho. 🎉');
  };
  const markLost = () => {
    void saveDealField({ status: 'lost', lost_reason: lostReason.trim() || null }, 'Marcado como perdido.');
    setLostReasonOpen(false);
  };
  const reopen = () => {
    setLostReason('');
    void saveDealField({ status: 'open' }, 'Negócio reaberto.');
  };

  const changePipeline = async (pipelineId: string) => {
    const supabase = getSupabase();
    const { data: st } = await supabase.from('stages').select('id').eq('pipeline_id', pipelineId).order('position').limit(1);
    const firstStage = (st?.[0] as { id: string } | undefined)?.id ?? null;
    const err = await detail.saveDeal({ pipeline_id: pipelineId, stage_id: firstStage });
    if (err) { toast.error(err); return; }
    toast.success('Lead movido de funil.');
    await onChanged();
    onClose();
  };

  const saveDealField = async (patch: Partial<Deal>, okMsg = 'Salvo.') => {
    const err = await detail.saveDeal(patch);
    if (err) toast.error(err);
    else { toast.success(okMsg); void onChanged(); }
  };

  const saveContactField = async (patch: Parameters<typeof detail.saveContact>[0]) => {
    const err = await detail.saveContact(patch);
    if (err) toast.error(err);
    else { toast.success('Salvo.'); void onChanged(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Detalhe do lead">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside
        className="relative z-10 flex h-full w-full max-w-full flex-col overflow-y-auto border-l border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] shadow-[0_0_60px_rgba(59,130,246,0.12)] transition-transform duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] sm:w-[460px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[rgba(59,130,246,0.12)] bg-[#0A0A0F]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="text-label">Lead</div>
            {/* Título = nome do lead (contato), editável */}
            <InlineText
              value={contact?.name ?? ''}
              placeholder="Nome do lead"
              onSave={(v) => saveContactField({ name: v || null })}
              className="text-lg font-bold text-display"
            />
            {/* Subtítulo = produtos comprados (multi-select do catálogo) */}
            <ProductMultiSelect
              selected={products}
              catalog={productCatalog}
              onAdd={async (name) => { await detail.addProduct(name); void onChanged(); }}
              onRemove={async (id) => { await detail.removeProduct(id); void onChanged(); }}
            />
          </div>
          <button onClick={onClose} aria-label="Fechar" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-4 rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm text-[#EF4444]">{error}</div>
        )}

        {loading && !contact ? (
          <div className="p-6 text-label opacity-60">Carregando ficha...</div>
        ) : (
          <div className="space-y-6 p-5">
            {/* Valor + temperatura + tipo */}
            <section className="grid grid-cols-2 gap-3">
              <Field label="Valor">
                <InlineText
                  value={String(deal.value ?? 0)}
                  type="number"
                  render={(v) => brl(Number(v) || 0)}
                  validate={(v) => (isNaN(Number(v)) ? 'Valor inválido.' : null)}
                  onSave={(v) => saveDealField({ value: Number(v) || 0 })}
                  className="text-sm font-semibold text-[var(--accent-secondary)]"
                />
              </Field>
              <Field label="Temperatura">
                <select
                  value={deal.temperature}
                  onChange={(e) => saveDealField({ temperature: e.target.value as Temperature }, 'Temperatura atualizada.')}
                  className={inputCls}
                >
                  {(Object.keys(TEMPERATURE_STYLE) as Temperature[]).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Tipo">
                <select value={deal.lead_type} onChange={(e) => saveDealField({ lead_type: e.target.value as LeadType }, 'Tipo atualizado.')} className={inputCls}>
                  <option value="Lead">Lead</option>
                  <option value="Cliente">Cliente</option>
                </select>
              </Field>
              <Field label="Última compra">
                <input
                  type="date"
                  defaultValue={deal.last_purchase_at ?? ''}
                  onChange={(e) => saveDealField({ last_purchase_at: e.target.value || null }, 'Data salva.')}
                  className={inputCls}
                />
              </Field>
            </section>

            {/* Status do negócio (ganho / perdido) */}
            <section className="space-y-2">
              <div className="text-label">Status do negócio</div>
              {deal.status === 'open' ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      onClick={markWon}
                      className="flex-1 rounded-lg border border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.1)] py-2 text-sm font-semibold text-[#10B981] transition hover:bg-[rgba(16,185,129,0.18)]"
                    >
                      Marcar como ganho
                    </button>
                    <button
                      onClick={() => setLostReasonOpen((v) => !v)}
                      className="flex-1 rounded-lg border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] py-2 text-sm font-semibold text-[#EF4444] transition hover:bg-[rgba(239,68,68,0.16)]"
                    >
                      Marcar como perdido
                    </button>
                  </div>
                  {lostReasonOpen && (
                    <div className="space-y-2 rounded-lg border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.05)] p-3">
                      <input
                        value={lostReason}
                        onChange={(e) => setLostReason(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && markLost()}
                        placeholder="Motivo da perda (opcional)"
                        className={inputCls}
                        autoFocus
                      />
                      <button
                        onClick={markLost}
                        className="w-full rounded-lg bg-[#EF4444] py-2 text-sm font-semibold text-white transition hover:opacity-90"
                      >
                        Confirmar perda
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ' +
                        (deal.status === 'won'
                          ? 'bg-[rgba(16,185,129,0.14)] text-[#10B981]'
                          : 'bg-[rgba(239,68,68,0.14)] text-[#EF4444]')
                      }
                    >
                      {deal.status === 'won' ? 'Ganho' : 'Perdido'} ·{' '}
                      {fmtDate(deal.status === 'won' ? deal.won_at : deal.lost_at)}
                    </span>
                    <button
                      onClick={reopen}
                      className="text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                      Reabrir
                    </button>
                  </div>
                  {deal.status === 'lost' && deal.lost_reason && (
                    <div className="text-xs text-[var(--color-text-secondary)]">
                      Motivo: <span className="text-[var(--color-text-primary)]">{deal.lost_reason}</span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Contato */}
            <section className="space-y-2">
              <div className="text-label">Contato</div>
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Phone className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                  <InlineText value={contact?.phone ?? ''} placeholder="Telefone" validate={(v) => (v && !isE164ish(v) ? 'Telefone inválido (use E.164).' : null)} onSave={(v) => saveContactField({ phone: v || null })} className="text-sm text-[var(--color-text-primary)]" />
                </div>
                <div className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                  <InlineText value={contact?.email ?? ''} placeholder="E-mail" validate={(v) => (v && !isEmail(v) ? 'E-mail inválido.' : null)} onSave={(v) => saveContactField({ email: v || null })} className="text-sm text-[var(--color-text-primary)]" />
                </div>
                {company && (
                  <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                    <Building2 className="h-3.5 w-3.5" /> {company}
                  </div>
                )}
              </div>
            </section>

            {/* Funil / etapa / responsável / origem */}
            <section className="grid grid-cols-2 gap-3">
              <Field label="Funil">
                <select value={deal.pipeline_id ?? ''} onChange={(e) => e.target.value && changePipeline(e.target.value)} className={inputCls}>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Etapa">
                <select value={stageId} onChange={(e) => void changeStage(e.target.value)} className={inputCls}>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Responsável">
                <select value={deal.owner_id ?? ''} onChange={(e) => saveDealField({ owner_id: e.target.value || null }, 'Responsável atualizado.')} className={inputCls}>
                  <option value="">Não atribuído</option>
                  {operators.map((o) => <option key={o.user_id} value={o.user_id}>{o.email}</option>)}
                </select>
              </Field>
              <Field label="Origem">
                <select value={contact?.source ?? ''} onChange={(e) => saveContactField({ source: e.target.value || null })} className={inputCls}>
                  <option value="">—</option>
                  {Object.entries(CONTACT_SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Criado em"><span className="text-sm text-[var(--color-text-primary)]">{fmtDate(deal.created_at)}</span></Field>
              <Field label="Última interação"><span className="text-sm text-[var(--color-text-primary)]">{fmtDate(deal.updated_at)}</span></Field>
            </section>

            {/* Origem do lead (rastreio UTM) — de onde este lead realmente veio */}
            <section className="space-y-2">
              <div className="text-label">Origem do lead (UTM)</div>
              {origin ? (
                <div className="space-y-3 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${TRAFFIC_TYPE_STYLE[origin.traffic ?? ''] ?? ''}`}>
                      {origin.highlight}
                    </span>
                    {origin.channel && (
                      <span className="text-sm font-semibold text-[var(--color-text-primary)]">{origin.channel}</span>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <OriginRow label="Campanha" value={deal.utm_campaign} />
                    <OriginRow label="Anúncio / Conteúdo" value={deal.utm_content} />
                    <OriginRow label="utm_source" value={deal.utm_source} />
                    <OriginRow label="utm_medium" value={deal.utm_medium} />
                    <OriginRow label="Termo (utm_term)" value={deal.utm_term} />
                  </dl>
                </div>
              ) : (
                <p className="text-sm text-[var(--color-text-secondary)] opacity-70">
                  Sem parâmetros de origem (UTM). Lead manual ou entrada direta.
                </p>
              )}
            </section>

            <Link to={`/inbox?contact=${deal.contact_id}`} className="flex items-center justify-center gap-2 rounded-lg border border-[rgba(59,130,246,0.2)] py-2.5 text-sm font-medium text-[var(--accent-secondary)] transition hover:border-[var(--accent-primary)] hover:bg-white/5">
              <MessageSquare className="h-4 w-4" /> Abrir conversa no inbox
            </Link>

            {/* Tags */}
            <ChipEditor
              label="Tags"
              chips={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
              catalog={tagCatalog.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
              onAdd={detail.addTag}
              onRemove={detail.removeTag}
              colored
            />

            {/* Campos personalizados */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-label">Campos personalizados</div>
                {isAdmin && (
                  <button onClick={() => setFieldModal(true)} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]">
                    <Plus className="h-3 w-3" /> Novo campo
                  </button>
                )}
              </div>
              {fields.length === 0 ? (
                <p className="text-sm text-[var(--color-text-secondary)] opacity-70">Nenhum campo personalizado ainda.{isAdmin && ' Crie o primeiro em "Novo campo".'}</p>
              ) : (
                <div className="space-y-3">
                  {fields.map((f) => (
                    <CustomFieldInput key={f.id} field={f} value={values[f.id] ?? ''} onSave={(v) => detail.saveValue(f.id, v)} />
                  ))}
                </div>
              )}
            </section>

            {/* Próxima ação (follow-up manual) ancorada neste negócio */}
            <ProximaAcao dealId={deal.id} />

            {/* Notas internas */}
            <section className="space-y-3">
              <div className="text-label">Notas internas</div>
              <div className="flex gap-2">
                <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submitNote()} placeholder="Anotar algo sobre este lead…" className={inputCls} />
                <button onClick={submitNote} disabled={savingNote || !note.trim()} className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60">
                  {savingNote ? '…' : 'Anotar'}
                </button>
              </div>
              <ol className="space-y-2">
                {notes.length === 0 ? (
                  <li className="text-sm text-[var(--color-text-secondary)] opacity-70">Sem notas ainda.</li>
                ) : (
                  notes.map((n) => (
                    <li key={n.id} className="glass-card p-3">
                      <p className="whitespace-pre-wrap text-sm text-[var(--color-text-primary)]">{n.body ?? n.title}</p>
                      <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{fmtDate(n.created_at)}</div>
                    </li>
                  ))
                )}
              </ol>
            </section>
          </div>
        )}
      </aside>

      {fieldModal && (
        <CustomFieldModal onClose={() => setFieldModal(false)} onCreate={async (input) => { const created = await detail.createField(input); if (created) setFieldModal(false); }} />
      )}
    </div>
  );
}

// Subtítulo do drawer: produtos que o lead comprou, como dropdown de múltipla
// escolha sobre o catálogo (Configurações → Produtos). Aberto, o drawer exibe
// todos os selecionados; o card minimizado do funil resume ("X e outros").
function ProductMultiSelect({
  selected, catalog, onAdd, onRemove,
}: {
  selected: { id: string; name: string }[];
  catalog: { id: string; name: string }[];
  onAdd: (name: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected.map((p) => p.id));
  const label = selected.length > 0 ? selected.map((p) => p.name).join(', ') : 'Selecionar produtos…';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Produtos comprados — clique para editar"
        className="flex w-full items-start gap-1 text-left text-sm text-[var(--color-text-secondary)] hover:opacity-80"
      >
        <span className={`min-w-0 flex-1 break-words ${selected.length === 0 ? 'opacity-70' : ''}`}>{label}</span>
        <ChevronDown className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-1 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
            {catalog.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">
                Nenhum produto no catálogo. Cadastre em Configurações → Produtos.
              </div>
            ) : (
              catalog.map((p) => {
                const active = chosen.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void (active ? onRemove(p.id) : onAdd(p.name))}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-white/5"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        active
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]'
                          : 'border-[rgba(59,130,246,0.35)]'
                      }`}
                    >
                      {active && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Linha "rótulo → valor" de um parâmetro de origem. Mostra "—" quando ausente.
function OriginRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={`truncate text-sm ${value ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] opacity-60'}`}>
        {value || '—'}
      </dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">{label}</div>
      {children}
    </div>
  );
}

// Edição inline: clica → vira input; Enter/blur salva (com validação); Esc cancela.
function InlineText({
  value, onSave, type = 'text', placeholder, validate, render, className,
}: {
  value: string;
  onSave: (value: string) => void | Promise<void>;
  type?: 'text' | 'number' | 'email' | 'tel';
  placeholder?: string;
  validate?: (v: string) => string | null;
  render?: (v: string) => string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => setLocal(value), [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    const problem = validate?.(local) ?? null;
    if (problem) { setErr(problem); return; }
    setErr(null);
    setEditing(false);
    if (local !== value) void onSave(local);
  };

  if (!editing) {
    const shown = value ? (render ? render(value) : value) : (placeholder ?? '—');
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`block w-full truncate text-left hover:opacity-80 ${value ? '' : 'text-[var(--color-text-secondary)] opacity-70'} ${className ?? ''}`}
        title="Clique para editar"
      >
        {shown}
      </button>
    );
  }

  return (
    <div>
      <input
        ref={ref}
        type={type}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setLocal(value); setErr(null); setEditing(false); } }}
        placeholder={placeholder}
        className="w-full rounded border border-[rgba(59,130,246,0.3)] bg-white/[0.05] px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
      />
      {err && <div className="mt-1 text-xs text-[#EF4444]">{err}</div>}
    </div>
  );
}

// Multi-select com autocomplete de catálogo + criação ao digitar. Usado por
// Produtos e Tags.
function ChipEditor({
  label, chips, catalog, onAdd, onRemove, colored,
}: {
  label: string;
  chips: { id: string; name: string; color?: string; meta?: string }[];
  catalog: { id: string; name: string; color?: string }[];
  onAdd: (name: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  colored?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const chosen = new Set(chips.map((c) => c.name.toLowerCase()));
  const suggestions = catalog
    .filter((c) => !chosen.has(c.name.toLowerCase()) && c.name.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 6);
  const exact = catalog.some((c) => c.name.toLowerCase() === q.trim().toLowerCase());

  const add = async (name: string) => {
    await onAdd(name);
    setQ('');
    setOpen(false);
  };

  return (
    <section className="space-y-2">
      <div className="text-label">{label}</div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
              style={colored && c.color ? { background: `${c.color}22`, color: c.color } : undefined}
            >
              {(!colored || !c.color) && <span className="text-[var(--color-text-primary)]">{c.name}</span>}
              {colored && c.color && c.name}
              {c.meta && <span className="font-semibold text-[var(--accent-secondary)]">{c.meta}</span>}
              <button onClick={() => void onRemove(c.id)} className="opacity-70 hover:opacity-100" aria-label={`Remover ${c.name}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { e.preventDefault(); void add(q.trim()); } }}
          placeholder={`Adicionar ${label.toLowerCase()}…`}
          className={inputCls}
        />
        {open && (q.trim() || suggestions.length > 0) && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-1 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
              {suggestions.map((s) => (
                <button key={s.id} onClick={() => void add(s.name)} className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-white/5">
                  {s.name}
                </button>
              ))}
              {q.trim() && !exact && (
                <button onClick={() => void add(q.trim())} className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--accent-secondary)] hover:bg-white/5">
                  <Plus className="h-3 w-3" /> Criar “{q.trim()}”
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function CustomFieldInput({ field, value, onSave }: { field: CustomField; value: string; onSave: (value: string) => void | Promise<void> }) {
  const [local, setLocal] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setLocal(value), [value]);

  const commit = (v: string) => {
    if (field.required && !v.trim()) { setErr(`"${field.label}" é obrigatório.`); return; }
    setErr(null);
    void onSave(v);
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
        {field.label}{field.required && <span className="text-[#EF4444]">*</span>}
      </div>
      {field.field_type === 'boolean' ? (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-primary)]">
          <input type="checkbox" checked={local === 'true'} onChange={(e) => { const v = e.target.checked ? 'true' : 'false'; setLocal(v); commit(v); }} className="h-4 w-4 accent-[#3B82F6]" />
          {local === 'true' ? 'Sim' : 'Não'}
        </label>
      ) : field.field_type === 'select' ? (
        <select value={local} onChange={(e) => { setLocal(e.target.value); commit(e.target.value); }} className={inputCls}>
          <option value="">Selecione…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => commit(local)}
          className={inputCls}
        />
      )}
      {err && <div className="mt-1 text-xs text-[#EF4444]">{err}</div>}
    </div>
  );
}

function CustomFieldModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (input: { label: string; field_type: CustomFieldType; options: string[] | null; required: boolean }) => void | Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [optionsRaw, setOptionsRaw] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!label.trim()) { setErr('Informe o nome do campo.'); return; }
    const options = type === 'select' ? optionsRaw.split(',').map((o) => o.trim()).filter(Boolean) : null;
    if (type === 'select' && (!options || options.length === 0)) { setErr('Informe ao menos uma opção (separadas por vírgula).'); return; }
    setBusy(true);
    await onCreate({ label: label.trim(), field_type: type, options, required });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-5 shadow-[0_0_40px_rgba(59,130,246,0.15)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-display">Novo campo personalizado</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Nome do campo</div>
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex: CNPJ, Segmento…" className={inputCls} />
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Tipo</div>
            <select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} className={inputCls}>
              {(Object.keys(CUSTOM_FIELD_TYPE_LABEL) as CustomFieldType[]).map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          {type === 'select' && (
            <div>
              <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Opções (separadas por vírgula)</div>
              <input value={optionsRaw} onChange={(e) => setOptionsRaw(e.target.value)} placeholder="A, B, C" className={inputCls} />
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-primary)]">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="h-4 w-4 accent-[#3B82F6]" /> Obrigatório
          </label>
          {err && <div className="text-xs text-[#EF4444]">{err}</div>}
        </div>
        <div className="mt-5 flex gap-2">
          <button onClick={submit} disabled={busy} className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60">
            <Check className="h-4 w-4" /> {busy ? 'Criando…' : 'Criar campo'}
          </button>
          <button onClick={onClose} className="rounded-lg border border-[rgba(59,130,246,0.2)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">Cancelar</button>
        </div>
      </div>
    </div>
  );
}
