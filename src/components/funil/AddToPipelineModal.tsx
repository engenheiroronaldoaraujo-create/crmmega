import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import type { Pipeline, Stage } from '@/types/crm';

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

interface AddToPipelineModalProps {
  contactId: string;
  contactName?: string | null;
  onClose: () => void;
  onCreated?: () => void;
}

// Cria um novo negócio para um contato existente, escolhendo funil e etapa.
// Usado na ficha do contato e no painel do inbox — cobre o caso de um cliente
// que entra em uma nova negociação.
export function AddToPipelineModal({ contactId, contactName, onClose, onCreated }: AddToPipelineModalProps) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [title, setTitle] = useState(contactName ? `Negociação — ${contactName}` : 'Nova negociação');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    void supabase
      .from('pipelines')
      .select('*')
      .eq('kind', 'comercial')
      .order('position')
      .then(({ data, error }) => {
        if (error) { setErr(error.message); return; }
        const list = (data ?? []) as Pipeline[];
        setPipelines(list);
        setPipelineId((list.find((p) => p.is_default) ?? list[0])?.id ?? '');
      });
  }, []);

  useEffect(() => {
    if (!pipelineId) { setStages([]); setStageId(''); return; }
    const supabase = getSupabase();
    void supabase
      .from('stages')
      .select('*')
      .eq('pipeline_id', pipelineId)
      .order('position')
      .then(({ data, error }) => {
        if (error) { setErr(error.message); return; }
        const list = (data ?? []) as Stage[];
        setStages(list);
        setStageId(list[0]?.id ?? '');
      });
  }, [pipelineId]);

  const submit = async () => {
    if (!title.trim()) { setErr('Informe o nome do negócio.'); return; }
    if (!pipelineId || !stageId) { setErr('Escolha o funil e a etapa.'); return; }
    setBusy(true);
    setErr(null);
    const supabase = getSupabase();
    // Etapa de ganho/perda escolhida direto → status e timestamp já no insert
    // (o trigger de won_at/lost_at só cobre UPDATE de status), mantendo o
    // dashboard consistente com o funil.
    const stage = stages.find((s) => s.id === stageId);
    const nowISO = new Date().toISOString();
    const { error } = await supabase.from('deals').insert({
      title: title.trim(),
      contact_id: contactId,
      value: Number(value) || 0,
      pipeline_id: pipelineId,
      stage_id: stageId,
      status: stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open',
      ...(stage?.is_won ? { won_at: nowISO } : stage?.is_lost ? { lost_at: nowISO } : {}),
      lead_type: 'Cliente',
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    toast.success('Negócio adicionado ao pipeline.');
    onCreated?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-[rgba(59,130,246,0.25)] bg-[#0A0A0F] p-5 shadow-[0_0_40px_rgba(59,130,246,0.15)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-display">Adicionar no pipeline</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Nome do negócio</div>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título do negócio" className={inputCls} />
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Funil</div>
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={inputCls}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Etapa</div>
            <select value={stageId} onChange={(e) => setStageId(e.target.value)} className={inputCls}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Valor (opcional)</div>
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" className={inputCls} />
          </div>
          {err && <div className="text-xs text-[#EF4444]">{err}</div>}
        </div>
        <div className="mt-5 flex gap-2">
          <Button className="flex-1" onClick={submit} disabled={busy || !pipelineId || !stageId}>
            {busy ? 'Adicionando…' : 'Adicionar'}
          </Button>
          <button onClick={onClose} className="rounded-lg border border-[rgba(59,130,246,0.2)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">Cancelar</button>
        </div>
      </div>
    </div>
  );
}
