import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, GripVertical, Plus, Star, Trash2, X } from 'lucide-react';
import type { FunilController } from '@/app/routes/funil/FunilPage';
import type { Stage } from '@/types/crm';

const STAGE_COLORS = ['#3B82F6', '#60A5FA', '#10B981', '#FBBF24', '#F87171', '#A78BFA', '#94A3B8'];

export function FunilManager({ funil, onClose }: { funil: FunilController; onClose: () => void }) {
  const {
    pipelines, selectedId, select, stages,
    createPipeline, renamePipeline, deletePipeline, setDefaultPipeline,
    addStage, renameStage, setStageColor, setStageProbability, setStageAiCriteria, reorderStages, removeStage,
  } = funil;

  const [newFunil, setNewFunil] = useState('');
  const [newStage, setNewStage] = useState('');
  const [busy, setBusy] = useState(false);
  const dragIdx = useRef<number | null>(null);

  const inputCls =
    'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

  const handleCreateFunil = async () => {
    if (!newFunil.trim()) return;
    setBusy(true);
    await createPipeline(newFunil);
    setNewFunil('');
    setBusy(false);
  };

  const handleDeleteFunil = async (id: string) => {
    const res = await deletePipeline(id);
    if (!res.ok) toast.error(res.error ?? 'Falha ao excluir funil.');
    else toast.success('Funil excluído.');
  };

  const onStageDrop = (targetIdx: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === targetIdx) return;
    const ids = stages.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(targetIdx, 0, moved);
    void reorderStages(ids);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] shadow-[0_0_40px_rgba(59,130,246,0.15)]"
      >
        <div className="flex items-center justify-between border-b border-[rgba(59,130,246,0.12)] px-5 py-4">
          <h3 className="text-base font-bold text-display">Gerenciar funis</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 md:grid-cols-2">
          {/* Coluna: funis */}
          <section className="space-y-3">
            <div className="text-label">Funis</div>
            <div className="space-y-2">
              {pipelines.map((p) => (
                <div
                  key={p.id}
                  className={`rounded-lg border px-3 py-2 ${p.id === selectedId ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.06)]' : 'border-[rgba(59,130,246,0.15)]'}`}
                >
                  <div className="flex items-center gap-2">
                    <button onClick={() => select(p.id)} className="flex-1 text-left text-sm text-[var(--color-text-primary)]">
                      {p.name}
                    </button>
                    <button
                      title="Definir como padrão"
                      onClick={() => void setDefaultPipeline(p.id)}
                      className={p.is_default ? 'text-[#FBBF24]' : 'text-[var(--color-text-secondary)] hover:text-[#FBBF24]'}
                    >
                      <Star className="h-4 w-4" fill={p.is_default ? '#FBBF24' : 'none'} />
                    </button>
                    <button title="Excluir" onClick={() => void handleDeleteFunil(p.id)} className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <input
                    defaultValue={p.name}
                    onBlur={(e) => { if (e.target.value.trim() && e.target.value !== p.name) void renamePipeline(p.id, e.target.value); }}
                    className="mt-1 w-full rounded border border-[rgba(59,130,246,0.15)] bg-transparent px-2 py-1 text-xs text-[var(--color-text-secondary)] outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newFunil} onChange={(e) => setNewFunil(e.target.value)} placeholder="Novo funil…" className={inputCls} />
              <button onClick={handleCreateFunil} disabled={busy || !newFunil.trim()} className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </section>

          {/* Coluna: estágios do funil selecionado */}
          <section className="space-y-3">
            <div className="text-label">Estágios de “{pipelines.find((p) => p.id === selectedId)?.name ?? '—'}”</div>
            <div className="space-y-2">
              {stages.map((s, i) => (
                <StageRow
                  key={s.id}
                  stage={s}
                  stages={stages}
                  onDragStart={() => (dragIdx.current = i)}
                  onDrop={() => onStageDrop(i)}
                  onRename={(name) => void renameStage(s.id, name)}
                  onColor={(c) => void setStageColor(s.id, c)}
                  onProbability={(p) => void setStageProbability(s.id, p)}
                  onAiCriteria={(t) => void setStageAiCriteria(s.id, t)}
                  onRemove={(moveTo) => removeStage(s.id, moveTo)}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="Novo estágio…" className={inputCls} />
              <button
                onClick={async () => { if (newStage.trim()) { await addStage(newStage); setNewStage(''); } }}
                disabled={!newStage.trim()}
                className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">Arraste pela alça para reordenar.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function StageRow({
  stage, stages, onDragStart, onDrop, onRename, onColor, onProbability, onAiCriteria, onRemove,
}: {
  stage: Stage;
  stages: Stage[];
  onDragStart: () => void;
  onDrop: () => void;
  onRename: (name: string) => void;
  onColor: (color: string | null) => void;
  onProbability: (probability: number) => void;
  onAiCriteria: (criteria: string) => void;
  onRemove: (moveToStageId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const others = stages.filter((s) => s.id !== stage.id);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="rounded-lg border border-[rgba(59,130,246,0.15)] bg-white/[0.02] px-2 py-2"
    >
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-[var(--color-text-secondary)]" />
        <input
          defaultValue={stage.name}
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== stage.name) onRename(e.target.value); }}
          className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
        />
        {(stage.is_won || stage.is_lost) && (
          <span className="text-[10px] text-[var(--color-text-secondary)]">{stage.is_won ? 'ganho' : 'perdido'}</span>
        )}
        <button title="Excluir estágio" onClick={() => setConfirming((v) => !v)} className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-6">
        <div className="flex items-center gap-1">
          {STAGE_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onColor(stage.color === c ? null : c)}
              className={`h-3.5 w-3.5 rounded-full ring-offset-1 ring-offset-[#0A0A0F] ${stage.color === c ? 'ring-2 ring-white' : ''}`}
              style={{ background: c }}
              aria-label={`Cor ${c}`}
            />
          ))}
        </div>
        {/* Probabilidade de fechamento (forecast) */}
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
          Prob.
          <input
            type="number"
            min={0}
            max={100}
            defaultValue={stage.probability}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v) && v !== stage.probability) onProbability(v);
            }}
            className="w-14 rounded border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-1.5 py-0.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
          />
          %
        </label>
      </div>

      {/* Critério para a IA mover o lead para este estágio (Módulo 8) */}
      <div className="mt-1.5 pl-6">
        <textarea
          defaultValue={stage.ai_criteria ?? ''}
          onBlur={(e) => { if (e.target.value.trim() !== (stage.ai_criteria ?? '').trim()) onAiCriteria(e.target.value); }}
          rows={2}
          placeholder="Critério p/ a IA mover o lead p/ cá (ex.: lead pediu proposta). Vazio = a IA não move para este estágio."
          className="w-full resize-y rounded border border-[rgba(59,130,246,0.15)] bg-white/[0.02] px-2 py-1 text-[11px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)]"
        />
      </div>

      {confirming && (
        <div className="mt-2 space-y-2 rounded-md border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.06)] p-2">
          <div className="text-[11px] text-[var(--color-text-secondary)]">Mover negócios deste estágio para:</div>
          <div className="flex items-center gap-2">
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="flex-1 rounded border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none">
              <option value="">Selecione…</option>
              {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button
              disabled={!moveTo}
              onClick={async () => {
                const res = await onRemove(moveTo);
                if (!res.ok) toast.error(res.error ?? 'Falha ao excluir.');
                else { toast.success('Estágio excluído.'); setConfirming(false); }
              }}
              className="inline-flex items-center gap-1 rounded bg-[var(--color-error)] px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Check className="h-3 w-3" /> Confirmar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
