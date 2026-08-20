import { useState } from 'react';
import { toast } from 'sonner';
import { Info, Pencil, Plus, RefreshCw, Send, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTemplates } from '@/hooks/useTemplates';
import { TemplateFormDialog } from '@/components/templates/TemplateFormDialog';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { getSupabase } from '@/lib/supabase';
import type { Template, TemplateStatus } from '@/types/templates';

const STATUS_LABEL: Record<TemplateStatus, string> = {
  draft: 'Rascunho',
  pending: 'Aguardando Meta',
  approved: 'Aprovado',
  rejected: 'Rejeitado',
};

const STATUS_COLORS: Record<TemplateStatus, string> = {
  draft: 'bg-white/5 text-[var(--color-text-secondary)]',
  pending: 'bg-[rgba(245,158,11,0.12)] text-[#FBBF24]',
  approved: 'bg-[rgba(16,185,129,0.12)] text-[var(--color-success)]',
  rejected: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]',
};

export function TemplatesList() {
  const { templates, loading, error, remove, reload } = useTemplates();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('sync-template-status', { body: {} });
    setSyncing(false);
    if (error || !data?.ok) {
      toast.error('Falha ao atualizar status', {
        description: data?.error ?? error?.message ?? 'Erro desconhecido',
      });
      return;
    }
    toast.success('Status sincronizado com a Meta.', {
      description: `${data.updated ?? 0} atualizado(s) · ${data.approved ?? 0} aprovado(s) · ${data.rejected ?? 0} rejeitado(s)`,
    });
    await reload();
  };

  const handleSubmitToMeta = async (t: Template) => {
    if (!confirm(`Enviar "${t.name}" para aprovação na Meta?`)) return;
    setSubmitting(t.id);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('submit-template', {
      body: { template_id: t.id },
    });
    setSubmitting(null);
    if (error || !data?.ok) {
      toast.error('Meta recusou', {
        description: data?.error ?? error?.message ?? 'Erro desconhecido',
      });
      await reload();
      return;
    }
    toast.success('Enviado para aprovação.', {
      description: `meta_template_id: ${data.meta_template_id ?? '—'}`,
    });
    await reload();
  };

  const handleDelete = async (t: Template) => {
    if (!confirm(`Remover template "${t.name}"?`)) return;
    setDeleting(t.id);
    try {
      await remove(t.id);
      toast.success(`Template "${t.name}" removido.`);
    } catch (err) {
      toast.error('Falha ao remover template', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {templates.length} template{templates.length !== 1 ? 's' : ''} cadastrado{templates.length !== 1 ? 's' : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar status
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Novo template
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[rgba(59,130,246,0.15)] bg-[rgba(59,130,246,0.05)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-[var(--accent-primary)]" />
        <span>
          Templates enviados passam por análise da Meta, que costuma levar de
          <strong className="text-[var(--color-text-primary)]"> 30 minutos a 24 horas</strong>.
          O status atualiza sozinho quando a Meta responde; use “Atualizar status” para
          forçar uma verificação.
        </span>
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}

      <div className="glass-card p-4">
        <div className="rounded-lg border border-[rgba(59,130,246,0.08)] overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="bg-white/[0.02] text-left">
                <th className="p-3 text-label">Nome</th>
                <th className="p-3 text-label">Categoria</th>
                <th className="p-3 text-label">Idioma</th>
                <th className="p-3 text-label">Status</th>
                <th className="p-3 text-label">Meta ID</th>
                <th className="p-3 w-48 text-right" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    Carregando...
                  </td>
                </tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    Nenhum template criado ainda.
                  </td>
                </tr>
              ) : (
                templates.map((t) => {
                  const canSubmit = t.status === 'draft' || t.status === 'rejected';
                  return (
                    <tr
                      key={t.id}
                      className="border-t border-[rgba(59,130,246,0.06)] hover:bg-white/[0.02]"
                    >
                      <td className="p-3 font-mono text-[var(--color-text-primary)]">
                        {t.name}
                      </td>
                      <td className="p-3 capitalize text-[var(--color-text-secondary)]">
                        {t.category}
                      </td>
                      <td className="p-3 text-[var(--color-text-secondary)]">
                        {t.language}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLORS[t.status]}`}
                        >
                          {STATUS_LABEL[t.status]}
                        </span>
                        {t.meta_template_status && t.status !== 'approved' && (
                          <div
                            className="text-[11px] text-[var(--color-error)] mt-1 max-w-[220px] truncate"
                            title={t.meta_template_status}
                          >
                            {t.meta_template_status}
                          </div>
                        )}
                      </td>
                      <td className="p-3 font-mono text-xs text-[var(--color-text-secondary)]">
                        {t.meta_template_id || <span className="opacity-40">—</span>}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-nowrap items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditing(t);
                              setShowForm(true);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Editar
                          </Button>
                          {canSubmit && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSubmitToMeta(t)}
                              disabled={submitting === t.id}
                            >
                              {submitting === t.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="h-3.5 w-3.5" />
                              )}
                              Submeter
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(t)}
                            disabled={deleting === t.id}
                            aria-label={`Remover ${t.name}`}
                          >
                            {deleting === t.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <TemplateFormDialog
        open={showForm}
        template={editing}
        onClose={() => setShowForm(false)}
        onSaved={reload}
      />
    </div>
  );
}
