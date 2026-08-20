import { useState, type ChangeEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BookOpen, Globe, Loader2, Plus, FileText, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { useKnowledgeBase } from '@/hooks/useKnowledgeBase';
import type { KnowledgeBase, KnowledgeStatus } from '@/types/knowledge';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';

const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  processing: 'Processando',
  ready: 'Pronto',
  error: 'Erro',
};
const STATUS_COLORS: Record<KnowledgeStatus, string> = {
  processing: 'bg-[rgba(245,158,11,0.12)] text-[#FBBF24] animate-pulse',
  ready: 'bg-[rgba(16,185,129,0.12)] text-[var(--color-success)]',
  error: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]',
};

export default function KnowledgePage() {
  const { items, loading, error, reload, addAndProcess, uploadPdf, remove } = useKnowledgeBase();
  const [showForm, setShowForm] = useState(false);

  const handleDelete = async (item: KnowledgeBase) => {
    if (!confirm(`Remover "${item.name}"? Todos os chunks serão apagados.`)) return;
    try {
      await remove(item.id);
      toast.success('Entrada removida.');
    } catch (err) {
      toast.error('Falha ao remover entrada', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <BookOpen className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">Base de Conhecimento</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Texto indexado com embeddings — consumido pelo agente IA via RAG
            </p>
          </div>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          Nova entrada
        </Button>
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}

      <div className="glass-card p-4">
        {/* Mobile (<md): lista de cartões em vez da tabela larga. */}
        <div className="md:hidden space-y-2">
          {loading ? (
            <div className="p-6 text-center text-[var(--color-text-secondary)] opacity-60">Carregando...</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-[var(--color-text-secondary)] opacity-60">
              Nenhuma entrada ainda. Adicione texto ou URL pra o agente IA consultar.
            </div>
          ) : (
            items.map((it) => {
              const Icon = it.type === 'url' ? Globe : FileText;
              return (
                <div key={it.id} className="rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02] p-3">
                  <div className="flex items-start gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)] mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[var(--color-text-primary)] truncate">{it.name}</div>
                      {it.source_url && (
                        <div className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate">{it.source_url}</div>
                      )}
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(it)} aria-label="Remover">
                      <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="uppercase tracking-wide text-[var(--color-text-secondary)]">{it.type}</span>
                    <span className="text-[var(--color-text-secondary)]">
                      {it.file_size_bytes > 0 ? `${Math.round(it.file_size_bytes / 1024)} KB` : '—'}
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${STATUS_COLORS[it.status]}`}>
                      {STATUS_LABEL[it.status]}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop (md+): tabela. */}
        <div className="hidden md:block rounded-lg border border-[rgba(59,130,246,0.08)] overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-white/[0.02] text-left">
                <th className="p-3 text-label w-10" />
                <th className="p-3 text-label">Nome</th>
                <th className="p-3 text-label">Tipo</th>
                <th className="p-3 text-label">Tamanho</th>
                <th className="p-3 text-label">Status</th>
                <th className="p-3 w-20 text-right" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    Carregando...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[var(--color-text-secondary)] opacity-60">
                    Nenhuma entrada ainda. Adicione texto ou URL pra o agente IA consultar.
                  </td>
                </tr>
              ) : (
                items.map((it) => {
                  const Icon = it.type === 'url' ? Globe : FileText;
                  return (
                    <tr key={it.id} className="border-t border-[rgba(59,130,246,0.06)]">
                      <td className="p-3">
                        <Icon className="h-4 w-4 text-[var(--color-text-secondary)]" />
                      </td>
                      <td className="p-3 text-[var(--color-text-primary)]">
                        <div className="font-semibold">{it.name}</div>
                        {it.source_url && (
                          <div className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate max-w-[320px]">
                            {it.source_url}
                          </div>
                        )}
                      </td>
                      <td className="p-3 uppercase text-[10px] tracking-wide text-[var(--color-text-secondary)]">
                        {it.type}
                      </td>
                      <td className="p-3 text-[var(--color-text-secondary)]">
                        {it.file_size_bytes > 0
                          ? `${Math.round(it.file_size_bytes / 1024)} KB`
                          : '—'}
                      </td>
                      <td className="p-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLORS[it.status]}`}>
                          {STATUS_LABEL[it.status]}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(it)}>
                          <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <KnowledgeFormDialog
        open={showForm}
        onClose={() => setShowForm(false)}
        uploadPdf={uploadPdf}
        onSubmit={async (input) => {
          const res = await addAndProcess(input);
          if (res?.chunks) {
            toast.success(`Processado: ${res.chunks} chunks indexados.`);
          } else if (res?.error) {
            toast.error('Processamento falhou', { description: res.error });
          } else if (res) {
            toast.warning('Entrada criada mas processamento falhou — veja status "Erro" na lista.');
          }
        }}
      />
    </div>
  );
}

function KnowledgeFormDialog({
  open,
  onClose,
  onSubmit,
  uploadPdf,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; source_type: 'text' | 'url' | 'pdf'; content: string }) => Promise<void>;
  uploadPdf: (file: File) => Promise<string | null>;
}) {
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<'text' | 'url' | 'pdf'>('text');
  const [content, setContent] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setSourceType('text');
    setContent('');
    setPdfFile(null);
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > 30 * 1024 * 1024) {
      toast.error('PDF acima de 30MB não é aceito.');
      return;
    }
    setPdfFile(f);
  };

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Dê um nome pra identificar essa entrada.');
      return;
    }
    if (sourceType !== 'pdf' && !content.trim()) {
      toast.error('Informe o conteúdo (texto ou URL).');
      return;
    }
    if (sourceType === 'pdf' && !pdfFile) {
      toast.error('Selecione um arquivo PDF.');
      return;
    }
    setSubmitting(true);
    try {
      let effectiveContent = content;
      if (sourceType === 'pdf' && pdfFile) {
        const path = await uploadPdf(pdfFile);
        if (!path) {
          toast.error('Falha ao fazer upload do PDF.');
          setSubmitting(false);
          return;
        }
        effectiveContent = path;
      }
      await onSubmit({ name, source_type: sourceType, content: effectiveContent });
      reset();
      onClose();
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Nova entrada na base de conhecimento">
      <form onSubmit={handle} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="kb_name">Nome</Label>
          <Input
            id="kb_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: FAQ de entregas, Política de reembolso"
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <Label>Tipo de fonte</Label>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: 'text' as const, icon: FileText, label: 'Texto direto' },
              { id: 'url' as const, icon: Globe, label: 'URL (HTML)' },
              { id: 'pdf' as const, icon: Upload, label: 'PDF' },
            ]).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSourceType(id)}
                className={
                  sourceType === id
                    ? 'p-3 rounded-lg border border-[var(--accent-primary)] bg-[rgba(59,130,246,0.08)] text-sm'
                    : 'p-3 rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] text-sm text-[var(--color-text-secondary)]'
                }
                disabled={submitting}
              >
                <Icon className="h-4 w-4 inline mr-2" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {sourceType === 'text' && (
          <div className="space-y-2">
            <Label htmlFor="kb_content">Texto</Label>
            <textarea
              id="kb_content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              disabled={submitting}
              placeholder="Cole o texto que deve alimentar o agente de IA (FAQ, procedimentos, políticas...)"
              className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
        )}

        {sourceType === 'url' && (
          <div className="space-y-2">
            <Label htmlFor="kb_content">URL</Label>
            <Input
              id="kb_content"
              type="url"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="https://..."
              disabled={submitting}
            />
          </div>
        )}

        {sourceType === 'pdf' && (
          <div className="space-y-2">
            <Label htmlFor="kb_file">PDF (máx 30MB)</Label>
            <label
              htmlFor="kb_file"
              className="flex items-center gap-3 h-11 px-4 rounded-lg border border-dashed border-[rgba(59,130,246,0.2)] bg-white/[0.03] cursor-pointer hover:border-[rgba(59,130,246,0.4)]"
            >
              <Upload className="h-4 w-4 text-[var(--color-text-secondary)]" />
              <span className="text-sm text-[var(--color-text-secondary)] truncate">
                {pdfFile?.name ?? 'Selecionar arquivo PDF'}
              </span>
              {pdfFile && (
                <span className="ml-auto text-[11px] text-[var(--color-text-secondary)]">
                  {Math.round(pdfFile.size / 1024)} KB
                </span>
              )}
            </label>
            <input
              id="kb_file"
              type="file"
              accept="application/pdf"
              onChange={handleFile}
              className="sr-only"
              disabled={submitting}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processando...
              </>
            ) : (
              'Adicionar e indexar'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
