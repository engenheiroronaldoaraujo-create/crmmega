import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Download,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useContacts,
  type ContactExportRow,
  type ContactSort,
  type LeadTypeFilter,
} from '@/hooks/useContacts';
import { useTags } from '@/hooks/useTags';
import { TagManagerDialog } from '@/components/contacts/TagManagerDialog';
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog';
import { ImportContactsDialog } from '@/components/contacts/ImportContactsDialog';
import type { ContactWithTags } from '@/types/db';
import { CONTACT_SOURCE_LABEL } from '@/types/crm';
import { TRAFFIC_LABEL } from '@/lib/dashboard';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 1000] as const;

const SOURCE_OPTIONS = ['whatsapp', 'instagram', 'import', 'manual'];

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

// CSV com separador ';' + BOM UTF-8 (padrão que o Excel pt-BR abre com acentos e
// colunas corretas). Campos: Nome, Telefone, E-mail, Canal, Origem, Tags,
// Primeiro registro.
function buildContactsCsv(rows: ContactExportRow[]): string {
  const header = ['Nome', 'Telefone', 'E-mail', 'Canal', 'Origem', 'Tags', 'Primeiro registro'];
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const day = (s: string | null) =>
    s ? new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const lines = rows.map((r) =>
    [
      r.name ?? '',
      r.phone ?? '',
      r.email ?? '',
      r.source ? CONTACT_SOURCE_LABEL[r.source] ?? r.source : '',
      r.traffic_type ? TRAFFIC_LABEL[r.traffic_type] ?? r.traffic_type : '',
      r.tags.join(', '),
      day(r.first_seen),
    ]
      .map((v) => esc(String(v)))
      .join(';'),
  );
  return '﻿' + [header.join(';'), ...lines].join('\r\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ContactsPage() {
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [leadTypeFilter, setLeadTypeFilter] = useState<LeadTypeFilter | null>(null);
  const [sort, setSort] = useState<ContactSort>('recent');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showTagManager, setShowTagManager] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ContactWithTags | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [exporting, setExporting] = useState(false);

  const { tags } = useTags();
  const { contacts, total, loading, error, remove, assignTags, reload, exportContacts } = useContacts({
    search,
    tagId: tagFilter,
    source: sourceFilter,
    leadType: leadTypeFilter,
    sort,
    page,
    pageSize,
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      // Com contatos selecionados na tabela, exporta só eles; senão, todos os
      // que batem nos filtros atuais.
      let rows = await exportContacts();
      if (selected.size > 0) rows = rows.filter((r) => selected.has(r.id));
      if (rows.length === 0) {
        toast.info(
          selected.size > 0
            ? 'Nenhum contato selecionado bate com os filtros atuais.'
            : 'Nenhum contato para exportar com os filtros atuais.',
        );
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(buildContactsCsv(rows), `contatos-${stamp}.csv`);
      toast.success(`${rows.length} contato(s) exportado(s).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível exportar os contatos.');
    } finally {
      setExporting(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = useMemo(
    () => contacts.length > 0 && contacts.every((c) => selected.has(c.id)),
    [contacts, selected],
  );

  const toggleSelectAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  };

  const [bulkBusy, setBulkBusy] = useState(false);

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Remover ${selected.size} contato(s)?`)) return;
    setBulkBusy(true);
    try {
      await remove(Array.from(selected));
      toast.success(`${selected.size} contato(s) removido(s).`);
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível remover os contatos.');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkTag = async (tagId: string) => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      await assignTags(Array.from(selected), [tagId]);
      const tag = tags.find((t) => t.id === tagId);
      toast.success(`Tag "${tag?.name}" aplicada a ${selected.size} contato(s).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível aplicar a tag.');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <Users className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">Contatos</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {total.toLocaleString('pt-BR')} contato{total !== 1 ? 's' : ''} no total
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setShowTagManager(true)}>
            <TagIcon className="h-4 w-4" />
            Tags
          </Button>
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <Upload className="h-4 w-4" />
            Importar
          </Button>
          <Button variant="outline" onClick={handleExport} disabled={exporting || loading}>
            <Download className="h-4 w-4" />
            {exporting
              ? 'Exportando…'
              : selected.size > 0
                ? `Exportar CSV (${selected.size})`
                : 'Exportar CSV'}
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Novo contato
          </Button>
        </div>
      </div>

      <div className="glass-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-secondary)]" />
            <input
              type="search"
              placeholder="Buscar por nome, telefone ou e-mail"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              className="w-full h-10 pl-10 pr-4 rounded-lg bg-white/[0.03] border border-[rgba(59,130,246,0.12)] text-sm placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
          <select
            value={tagFilter ?? ''}
            onChange={(e) => {
              setPage(1);
              setTagFilter(e.target.value || null);
            }}
            className="h-10 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Todas as tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            value={leadTypeFilter ?? ''}
            onChange={(e) => {
              setPage(1);
              setLeadTypeFilter((e.target.value || null) as LeadTypeFilter | null);
            }}
            className="h-10 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Leads e clientes</option>
            <option value="Lead">Somente leads</option>
            <option value="Cliente">Somente clientes</option>
          </select>
          <select
            value={sourceFilter ?? ''}
            onChange={(e) => {
              setPage(1);
              setSourceFilter(e.target.value || null);
            }}
            className="h-10 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Todos os canais</option>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {CONTACT_SOURCE_LABEL[s] ?? s}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => {
              setPage(1);
              setSort(e.target.value as ContactSort);
            }}
            className="h-10 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="recent">Mais recentes</option>
            <option value="oldest">Mais antigos</option>
            <option value="first_seen">Primeiro registro</option>
            <option value="name">Nome (A–Z)</option>
          </select>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.25)] bg-[rgba(59,130,246,0.06)] px-4 py-2">
            <span className="text-sm font-medium">
              {selected.size} selecionado{selected.size > 1 ? 's' : ''}
            </span>
            <div className="ml-auto flex items-center gap-1 flex-wrap">
              {tags.slice(0, 5).map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleBulkTag(t.id)}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-white/5 hover:bg-white/10"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                  + {t.name}
                </button>
              ))}
              <Button size="sm" variant="destructive" onClick={handleBulkDelete} disabled={bulkBusy}>
                <Trash2 className="h-3.5 w-3.5" />
                Remover
              </Button>
            </div>
          </div>
        )}

        {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}

        {/* Mobile (<md): lista de cartões em vez da tabela larga. */}
        <div className="md:hidden space-y-2">
          {loading ? (
            <div className="p-6 text-center text-[var(--color-text-secondary)] opacity-60">Carregando...</div>
          ) : contacts.length === 0 ? (
            <div className="p-6 text-center text-[var(--color-text-secondary)] opacity-60">
              {search || tagFilter || sourceFilter || leadTypeFilter
                ? 'Nenhum contato encontrado com estes filtros.'
                : 'Nenhum contato ainda — crie um manualmente ou importe CSV/XLSX.'}
            </div>
          ) : (
            contacts.map((c) => (
              <div key={c.id} className="rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02] p-3">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                    className="accent-[var(--accent-primary)] mt-1 shrink-0"
                    aria-label={`Selecionar ${c.name || c.phone || 'contato'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <Link to={`/contacts/${c.id}`} className="block truncate font-medium text-[var(--color-text-primary)] hover:text-[var(--accent-primary)]">
                      {c.name || '— ver ficha'}
                    </Link>
                    <div className="truncate font-mono text-xs text-[var(--color-text-secondary)]">
                      {c.phone || '—'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setEditing(c); setShowForm(true); }}
                  >
                    Editar
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                  {c.source && (
                    <span className="inline-flex rounded-full bg-white/5 px-2 py-0.5">
                      {CONTACT_SOURCE_LABEL[c.source] ?? c.source}
                    </span>
                  )}
                  {c.traffic_type && <span>{TRAFFIC_LABEL[c.traffic_type] ?? c.traffic_type}</span>}
                  <span className="opacity-70">{fmtDate(c.first_seen_at ?? c.created_at)}</span>
                </div>
                {c.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.tags.slice(0, 3).map((t) => (
                      <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.name}
                      </span>
                    ))}
                    {c.tags.length > 3 && (
                      <span className="text-xs text-[var(--color-text-secondary)] opacity-60">+{c.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Desktop (md+): tabela. */}
        <div className="hidden md:block rounded-lg border border-[rgba(59,130,246,0.08)] overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="bg-white/[0.02] text-left">
                <th className="p-3 w-10">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleSelectAllOnPage}
                    className="accent-[var(--accent-primary)]"
                    aria-label="Selecionar todos da página"
                  />
                </th>
                <th className="p-3 text-label">Nome</th>
                <th className="p-3 text-label">Telefone</th>
                <th className="p-3 text-label">Canal</th>
                <th className="p-3 text-label">Origem</th>
                <th className="p-3 text-label">Primeiro registro</th>
                <th className="p-3 text-label">Tags</th>
                <th className="p-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    Carregando...
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    {search || tagFilter || sourceFilter || leadTypeFilter
                      ? 'Nenhum contato encontrado com estes filtros.'
                      : 'Nenhum contato ainda — crie um manualmente ou importe CSV/XLSX.'}
                  </td>
                </tr>
              ) : (
                contacts.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-[rgba(59,130,246,0.06)] hover:bg-white/[0.02]"
                  >
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                        className="accent-[var(--accent-primary)]"
                      />
                    </td>
                    <td className="p-3">
                      <Link
                        to={`/contacts/${c.id}`}
                        className="font-medium text-[var(--color-text-primary)] hover:text-[var(--accent-primary)]"
                      >
                        {c.name || <span className="opacity-40">— ver ficha</span>}
                      </Link>
                    </td>
                    <td className="p-3 font-mono text-xs text-[var(--color-text-secondary)]">
                      {c.phone || <span className="opacity-40">—</span>}
                    </td>
                    <td className="p-3 text-[var(--color-text-secondary)]">
                      {c.source ? (
                        <span className="inline-flex rounded-full bg-white/5 px-2 py-0.5 text-xs">
                          {CONTACT_SOURCE_LABEL[c.source] ?? c.source}
                        </span>
                      ) : (
                        <span className="opacity-40">—</span>
                      )}
                    </td>
                    <td className="p-3 text-[var(--color-text-secondary)]">
                      {c.traffic_type ? (
                        <span className="text-xs">{TRAFFIC_LABEL[c.traffic_type] ?? c.traffic_type}</span>
                      ) : (
                        <span className="opacity-40">—</span>
                      )}
                    </td>
                    <td className="p-3 text-xs text-[var(--color-text-secondary)]">
                      {fmtDate(c.first_seen_at ?? c.created_at)}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((t) => (
                          <span
                            key={t.id}
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-white/5"
                          >
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                            {t.name}
                          </span>
                        ))}
                        {c.tags.length > 3 && (
                          <span className="text-xs text-[var(--color-text-secondary)] opacity-60">
                            +{c.tags.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(c);
                          setShowForm(true);
                        }}
                      >
                        Editar
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--color-text-secondary)]">
              Página {page} de {pageCount}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              Linhas
              <select
                value={pageSize}
                onChange={(e) => {
                  setPage(1);
                  setPageSize(Number(e.target.value));
                }}
                className="h-8 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.03] px-2 text-xs text-[var(--color-text-primary)]"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount || loading}
            >
              Próxima
            </Button>
          </div>
        </div>
      </div>

      <TagManagerDialog
        open={showTagManager}
        onClose={() => setShowTagManager(false)}
      />
      <ContactFormDialog
        open={showForm}
        contact={editing}
        onClose={() => setShowForm(false)}
        onSaved={reload}
      />
      <ImportContactsDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onDone={reload}
      />

    </div>
  );
}
