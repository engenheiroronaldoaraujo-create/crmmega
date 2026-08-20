import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Filter, Link2, MapPin, MessageSquare, Plus, X } from 'lucide-react';
import { useContactProfile } from '@/hooks/useContactProfile';
import { useContactTimeline, type DayGroup } from '@/hooks/useContactTimeline';
import { useContactChannelLinks, type ContactChannelLink } from '@/hooks/useContactChannelLinks';
import { useOperators } from '@/hooks/useOperators';
import { CONTACT_SOURCE_LABEL, getDealOrigin, TRAFFIC_TYPE_STYLE } from '@/types/crm';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { AddToPipelineModal } from '@/components/funil/AddToPipelineModal';
import { ProximaAcao } from '@/components/crm/ProximaAcao';
import { Button } from '@/components/ui/button';
import { type Deal } from '@/types/crm';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtTime = (s: string) => new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
const todayISO = () => new Date().toISOString().slice(0, 10);

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

const DOT: Record<string, string> = {
  conversa: 'bg-[#22C55E]',
  mudanca_estagio: 'bg-[#A78BFA]',
  nota: 'bg-[#64748B]',
  ganho: 'bg-[#10B981]',
  perdido: 'bg-[#EF4444]',
  acao_agendada: 'bg-[#3B82F6]',
  acao_concluida: 'bg-[#10B981]',
};

export default function ContactDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { contact, deals, loading, error, reload, saveContact } = useContactProfile(id);
  const { groups, addNoteToDay, reload: reloadTimeline } = useContactTimeline(id);
  const channelLinks = useContactChannelLinks(id);
  const { operators } = useOperators();
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showPipelineModal, setShowPipelineModal] = useState(false);

  const authorName = (uid: string | null | undefined) =>
    uid ? operators.find((o) => o.user_id === uid)?.email ?? 'Operador' : 'Sistema';

  if (loading && !contact) return <div className="text-label opacity-60">Carregando ficha...</div>;
  if (error && !contact)
    return (
      <div className="max-w-3xl">
        <LoadErrorBanner message={error} onRetry={() => void reload()} />
      </div>
    );
  if (!contact) return <div className="text-[var(--color-text-secondary)]">Contato não encontrado.</div>;

  const company = typeof contact.custom_fields?.company === 'string' ? String(contact.custom_fields.company) : '';

  const saveField = async (patch: Parameters<typeof saveContact>[0]) => {
    const err = await saveContact(patch);
    if (err) toast.error(err);
    else toast.success('Salvo.');
  };

  const saveCompany = async (value: string) => {
    const err = await saveContact({ custom_fields: { ...(contact.custom_fields ?? {}), company: value || undefined } });
    if (err) toast.error(err);
    else toast.success('Salvo.');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]">
        <ArrowLeft className="h-4 w-4" /> Contatos
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl glass-card text-xl font-bold text-[var(--accent-primary)]">
            {(contact.name ?? contact.phone ?? '?').charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-display">{contact.name ?? 'Sem nome'}</h1>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--color-text-secondary)]">
              {contact.source && (
                <span className="rounded-full bg-white/5 px-2 py-0.5">
                  {CONTACT_SOURCE_LABEL[contact.source] ?? contact.source}
                </span>
              )}
              <span>Primeiro registro: {new Date(contact.first_seen_at ?? contact.created_at).toLocaleDateString('pt-BR')}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowPipelineModal(true)}>
            <Filter className="h-4 w-4" /> Adicionar no pipeline
          </Button>
          <Button variant="outline" onClick={() => setShowLinkModal(true)}>
            <Link2 className="h-4 w-4" /> Vincular canal
          </Button>
          <Button onClick={() => navigate(`/inbox?contact=${contact.id}`)}>
            <MessageSquare className="h-4 w-4" /> Abrir conversa
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Principal: campos editáveis + timeline */}
        <div className="space-y-5">
          <div className="glass-card p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InlineField label="Nome" value={contact.name ?? ''} onSave={(v) => saveField({ name: v || null })} />
            <InlineField label="Telefone" value={contact.phone ?? ''} onSave={(v) => saveField({ phone: v || null })} />
            <InlineField label="E-mail" value={contact.email ?? ''} onSave={(v) => saveField({ email: v || null })} />
            <InlineField label="Empresa" value={company} onSave={saveCompany} />
            <div>
              <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Canal / Origem</div>
              <select value={contact.source ?? ''} onChange={(e) => saveField({ source: e.target.value || null })} className={inputCls}>
                <option value="">—</option>
                {Object.entries(CONTACT_SOURCE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          <TimelineGrouped groups={groups} onAddNote={async (d, t) => { await addNoteToDay(d, t); }} authorName={authorName} />
        </div>

        {/* Lateral: negócios + vínculos */}
        <div className="space-y-5">
          <SidePanel title="Negócios" empty="Nenhum negócio.">
            {deals.map((d) => (
              <DealRow key={d.id} deal={d} />
            ))}
          </SidePanel>

          <div className="glass-card p-5">
            <ProximaAcao contactId={id} deals={deals.map((d) => ({ id: d.id, title: d.title }))} />
          </div>

          <div className="glass-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-label">Canais vinculados</div>
              <button onClick={() => setShowLinkModal(true)} className="text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]" aria-label="Vincular canal">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {channelLinks.links.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] opacity-70">Nenhum canal vinculado.</p>
            ) : (
              <div className="space-y-2">
                {channelLinks.links.map((l) => (
                  <ChannelLinkRow key={l.id} link={l} onUnlink={() => void channelLinks.unlink(l.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showPipelineModal && (
        <AddToPipelineModal
          contactId={contact.id}
          contactName={contact.name}
          onClose={() => setShowPipelineModal(false)}
          onCreated={() => { void reload(); void reloadTimeline(); }}
        />
      )}

      {showLinkModal && (
        <LinkChannelModal
          onClose={() => setShowLinkModal(false)}
          onLink={async (channel, identifier) => {
            try {
              await channelLinks.link(channel, identifier);
              toast.success('Canal vinculado.');
              setShowLinkModal(false);
              void reloadTimeline();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Falha ao vincular.');
            }
          }}
        />
      )}
    </div>
  );
}

function InlineField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void | Promise<void> }) {
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setLocal(value), [value]);
  const commit = () => { if (local !== value) void onSave(local); };
  return (
    <div>
      <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">{label}</div>
      <input
        ref={ref}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); ref.current?.blur(); } if (e.key === 'Escape') setLocal(value); }}
        placeholder="—"
        className={inputCls}
      />
    </div>
  );
}

function TimelineGrouped({
  groups,
  onAddNote,
  authorName,
}: {
  groups: DayGroup[];
  onAddNote: (date: string, text: string) => Promise<void>;
  authorName: (uid: string | null | undefined) => string;
}) {
  const [openNoteFor, setOpenNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (date: string) => {
    if (!noteText.trim()) return;
    setBusy(true);
    await onAddNote(date, noteText);
    setNoteText('');
    setOpenNoteFor(null);
    setBusy(false);
  };

  // Sempre permite anotar no dia de hoje, mesmo sem outra atividade.
  const days = groups.some((g) => g.date === todayISO())
    ? groups
    : [{ date: todayISO(), entries: [] }, ...groups];

  return (
    <div>
      <div className="text-label mb-3">Linha do tempo</div>
      {days.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Sem histórico ainda.</div>
      ) : (
        <ol className="space-y-4">
          {days.map((g) => (
            <li key={g.date} className="glass-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">{fmtDay(g.date)}</span>
                <button
                  onClick={() => { setOpenNoteFor(openNoteFor === g.date ? null : g.date); setNoteText(''); }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]"
                >
                  <Plus className="h-3 w-3" /> Nota
                </button>
              </div>

              {openNoteFor === g.date && (
                <div className="mb-3 flex gap-2">
                  <input
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit(g.date)}
                    placeholder="Adicionar nota a esta data…"
                    className={inputCls}
                    autoFocus
                  />
                  <Button onClick={() => void submit(g.date)} disabled={busy || !noteText.trim()}>Anotar</Button>
                </div>
              )}

              {g.entries.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)] opacity-60">Sem atividade — use "Nota" para registrar algo.</p>
              ) : (
                <ul className="space-y-2">
                  {g.entries.map((e) => (
                    <li key={e.id} className="flex gap-3">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[e.kind] ?? 'bg-[#64748B]'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{e.label}</span>
                          <span className="text-[11px] text-[var(--color-text-secondary)]">
                            {fmtTime(e.at)}{e.kind === 'nota' && ` · ${authorName(e.author_id)}`}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">{e.text}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ChannelLinkRow({ link, onUnlink }: { link: ContactChannelLink; onUnlink: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[rgba(59,130,246,0.12)] px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          {link.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}
        </div>
        <div className="truncate text-sm text-[var(--color-text-primary)]">{link.channel_identifier}</div>
      </div>
      <button onClick={onUnlink} className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]" aria-label="Desvincular">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function LinkChannelModal({
  onClose,
  onLink,
}: {
  onClose: () => void;
  onLink: (channel: 'whatsapp' | 'instagram', identifier: string) => Promise<void>;
}) {
  const [channel, setChannel] = useState<'whatsapp' | 'instagram'>('instagram');
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-5 shadow-[0_0_40px_rgba(59,130,246,0.15)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-display">Vincular canal</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          Associe um Instagram (@usuário/ID) ou WhatsApp (E.164) a este contato para unificar as conversas dos dois canais.
        </p>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Canal</div>
            <select value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp' | 'instagram')} className={inputCls}>
              <option value="instagram">Instagram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
              {channel === 'instagram' ? '@usuário ou ID' : 'Número (E.164)'}
            </div>
            <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={channel === 'instagram' ? '@fulano' : '+5511999999999'} className={inputCls} autoFocus />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button
            className="flex-1"
            disabled={busy || !identifier.trim()}
            onClick={async () => { setBusy(true); await onLink(channel, identifier); setBusy(false); }}
          >
            Vincular
          </Button>
          <button onClick={onClose} className="rounded-lg border border-[rgba(59,130,246,0.2)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function SidePanel({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  const hasContent = items.some(Boolean) && items.flat().length > 0;
  return (
    <div className="glass-card p-5">
      <div className="text-label mb-3">{title}</div>
      {hasContent ? <div className="space-y-2">{children}</div> : <p className="text-sm text-[var(--color-text-secondary)] opacity-70">{empty}</p>}
    </div>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  const origin = getDealOrigin(deal);
  return (
    <Link to={`/funil?deal=${deal.id}`} className="block rounded-lg border border-[rgba(59,130,246,0.12)] px-3 py-2 hover:border-[var(--accent-primary)]">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--color-text-primary)]">{deal.title}</span>
        <span className="text-xs font-semibold text-[var(--accent-secondary)]">{brl(Number(deal.value) || 0)}</span>
      </div>
      {origin && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-semibold ${TRAFFIC_TYPE_STYLE[origin.traffic ?? ''] ?? ''}`}>
            {origin.highlight}
          </span>
          {(origin.channel || origin.campaign) && (
            <span className="flex min-w-0 items-center gap-1 text-[var(--color-text-secondary)]">
              <MapPin className="h-3 w-3 shrink-0 opacity-70" />
              <span className="truncate">{[origin.channel, origin.campaign].filter(Boolean).join(' · ')}</span>
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
