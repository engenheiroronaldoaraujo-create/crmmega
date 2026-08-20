import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Tag as TagIcon, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useTags } from '@/hooks/useTags';
import type { Tag } from '@/types/db';

interface TagManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_COLORS = [
  '#3B82F6', '#60A5FA', '#10B981', '#22C55E', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#14B8A6', '#F97316',
];

export function TagManagerDialog({ open, onClose }: TagManagerDialogProps) {
  const { tags, loading, create, update, remove } = useTags();
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);

  const resetForm = () => {
    setName('');
    setColor(DEFAULT_COLORS[0]);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Informe o nome da tag.');
      return;
    }
    setBusy(true);
    try {
      const t = await create({ name, color });
      if (t) {
        toast.success(`Tag "${t.name}" criada.`);
        resetForm();
      }
    } catch (err) {
      toast.error('Falha ao criar tag', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await update(editing.id, { name: editing.name.trim(), color: editing.color });
      setEditing(null);
    } catch (err) {
      toast.error('Falha ao salvar tag', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (t: Tag) => {
    if (!confirm(`Remover a tag "${t.name}"?`)) return;
    setBusy(true);
    try {
      await remove(t.id);
      toast.success(`Tag "${t.name}" removida.`);
    } catch (err) {
      toast.error('Falha ao remover tag', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Gerenciar tags"
      description="Tags ajudam a segmentar contatos para campanhas e filtros."
      widthClass="max-w-xl"
    >
      <form onSubmit={handleCreate} className="flex items-end gap-3 mb-6">
        <div className="flex-1 space-y-2">
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-text-label)]">
            Nova tag
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: lead-quente, cliente, campanha-julho"
            disabled={busy}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-text-label)]">
            Cor
          </label>
          <div className="flex items-center gap-1">
            {DEFAULT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-md border transition-all ${
                  color === c
                    ? 'border-white scale-110'
                    : 'border-transparent opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Selecionar cor ${c}`}
              />
            ))}
          </div>
        </div>
        <Button type="submit" disabled={busy}>
          <Plus className="h-4 w-4" />
          Adicionar
        </Button>
      </form>

      <div className="space-y-2">
        {loading ? (
          <div className="text-label opacity-60 py-6 text-center">Carregando...</div>
        ) : tags.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)] opacity-60 py-6 text-center">
            Nenhuma tag criada ainda.
          </div>
        ) : (
          <ul className="divide-y divide-[rgba(59,130,246,0.08)] rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02]">
            {tags.map((t) => {
              const isEditing = editing?.id === t.id;
              return (
                <li key={t.id} className="flex items-center gap-3 p-3">
                  {isEditing ? (
                    <>
                      <div className="flex items-center gap-1">
                        {DEFAULT_COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setEditing({ ...editing!, color: c })}
                            className={`h-6 w-6 rounded-md border transition-all ${
                              editing.color === c ? 'border-white scale-110' : 'border-transparent opacity-70'
                            }`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <Input
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        disabled={busy}
                      />
                      <Button size="icon" variant="ghost" onClick={handleSaveEdit} disabled={busy} aria-label="Salvar">
                        <Check className="h-4 w-4 text-[var(--color-success)]" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancelar">
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <div
                        className="h-6 w-6 rounded-md border border-white/10"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)]">
                        <TagIcon className="inline h-3.5 w-3.5 mr-1.5 opacity-50" />
                        {t.name}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ id: t.id, name: t.name, color: t.color })}
                      >
                        Editar
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDelete(t)}
                        aria-label={`Remover ${t.name}`}
                      >
                        <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
