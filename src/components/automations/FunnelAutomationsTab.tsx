// ============================================================================
// Automações → Funil: "Quando o lead entrar em [etapa] → executar [ações]".
// Regras em whatsapp_hub.funnel_automations; execução server-side pela Edge
// Function funnel-automation (trigger no banco em deals.stage_id).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Zap } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useOperators } from '@/hooks/useOperators';
import { useTags } from '@/hooks/useTags';
import { useTemplates } from '@/hooks/useTemplates';
import { CRM_ACTION_LABEL, CRM_ACTION_TYPES, type CrmActionType } from '@/types/crm';

interface Pipeline { id: string; name: string; is_default: boolean }
interface Stage { id: string; pipeline_id: string; name: string; position: number }
interface Automation {
  id: string;
  pipeline_id: string;
  stage_id: string;
  name: string;
  is_active: boolean;
  actions: ActionDef[];
}

type ActionDef = Record<string, unknown> & { type: string };

const ACTION_TYPES: { value: string; label: string }[] = [
  { value: 'add_tag', label: 'Adicionar tag' },
  { value: 'next_action', label: 'Agendar próxima ação' },
  { value: 'set_lead_type', label: 'Mudar Lead/Cliente' },
  { value: 'set_temperature', label: 'Mudar temperatura' },
  { value: 'send_template', label: 'Disparar template (API oficial)' },
  { value: 'send_text', label: 'Disparar mensagem de texto' },
  { value: 'assign', label: 'Atribuir a alguém da equipe' },
  { value: 'add_to_pipeline', label: 'Adicionar em outro funil' },
];

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

export function FunnelAutomationsTab() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>('');
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const { operators } = useOperators();
  const { tags } = useTags();
  const { templates } = useTemplates();
  const approvedTemplates = useMemo(() => templates.filter((t) => t.status === 'approved'), [templates]);

  const reload = useCallback(async () => {
    setLoading(true);
    const supabase = getSupabase();
    const [{ data: pipes }, { data: sts }, { data: autos }] = await Promise.all([
      supabase.from('pipelines').select('id, name, is_default').order('position'),
      supabase.from('stages').select('id, pipeline_id, name, position').order('position'),
      supabase.from('funnel_automations').select('*').order('created_at'),
    ]);
    const pipeList = (pipes ?? []) as Pipeline[];
    setPipelines(pipeList);
    setStages((sts ?? []) as Stage[]);
    setAutomations((autos ?? []) as Automation[]);
    setSelectedPipeline((cur) => cur || (pipeList.find((p) => p.is_default) ?? pipeList[0])?.id || '');
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const pipelineStages = stages.filter((s) => s.pipeline_id === selectedPipeline);
  const pipelineAutomations = automations.filter((a) => a.pipeline_id === selectedPipeline);
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? '—';

  const toggleActive = async (a: Automation) => {
    const supabase = getSupabase();
    const { error } = await supabase.from('funnel_automations').update({ is_active: !a.is_active }).eq('id', a.id);
    if (error) toast.error('Falha', { description: error.message });
    else await reload();
  };

  const removeAutomation = async (a: Automation) => {
    if (!confirm(`Excluir a automação "${a.name}"?`)) return;
    const supabase = getSupabase();
    const { error } = await supabase.from('funnel_automations').delete().eq('id', a.id);
    if (error) toast.error('Falha', { description: error.message });
    else await reload();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <span className={labelCls}>Funil</span>
          <select value={selectedPipeline} onChange={(e) => setSelectedPipeline(e.target.value)} className={inputCls}>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-2 self-end rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Nova automação
        </button>
      </div>

      {creating && (
        <AutomationForm
          stages={pipelineStages}
          pipelineId={selectedPipeline}
          pipelines={pipelines}
          allStages={stages}
          tags={tags}
          operators={operators}
          templates={approvedTemplates}
          onDone={async () => { setCreating(false); await reload(); }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <div className="text-label opacity-60">Carregando…</div>
      ) : pipelineAutomations.length === 0 ? (
        <div className="glass-card p-6 text-sm text-[var(--color-text-secondary)]">
          Nenhuma automação neste funil. Crie a primeira: quando o lead entrar numa etapa,
          o CRM executa as ações automaticamente (tags, próxima ação, mensagens, atribuição…).
        </div>
      ) : (
        <div className="space-y-3">
          {pipelineAutomations.map((a) => (
            <div key={a.id} className="glass-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-[var(--accent-primary)]" />
                    <span className="font-semibold text-[var(--color-text-primary)]">{a.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${a.is_active ? 'bg-[rgba(16,185,129,0.12)] text-[#10B981]' : 'bg-white/5 text-[var(--color-text-secondary)]'}`}>
                      {a.is_active ? 'Ativa' : 'Inativa'}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                    Quando o lead entrar em <span className="text-[var(--accent-secondary)]">{stageName(a.stage_id)}</span> →{' '}
                    {a.actions.map((act) => ACTION_TYPES.find((t) => t.value === act.type)?.label ?? act.type).join(' · ')}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void toggleActive(a)}
                    role="switch"
                    aria-checked={a.is_active}
                    className={`relative h-6 w-11 rounded-full transition-colors ${a.is_active ? 'bg-[var(--accent-primary)]' : 'bg-white/10'}`}
                  >
                    <span className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${a.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                  <button onClick={() => void removeAutomation(a)} className="rounded-md p-1.5 text-[var(--color-error)] transition hover:bg-white/5">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Builder ----------------------------------------------------------------

function AutomationForm({
  stages, pipelineId, pipelines, allStages, tags, operators, templates, onDone, onCancel,
}: {
  stages: Stage[];
  pipelineId: string;
  pipelines: Pipeline[];
  allStages: Stage[];
  tags: { id: string; name: string }[];
  operators: { user_id: string; email: string }[];
  templates: { id: string; name: string }[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [actions, setActions] = useState<ActionDef[]>([]);
  const [saving, setSaving] = useState(false);

  const addAction = () => setActions((cur) => [...cur, { type: 'add_tag' }]);
  const setAction = (i: number, patch: Partial<ActionDef>) =>
    setActions((cur) => cur.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const removeAction = (i: number) => setActions((cur) => cur.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!name.trim() || !stageId || actions.length === 0) {
      toast.error('Preencha nome, etapa e ao menos uma ação.');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase.from('funnel_automations').insert({
      pipeline_id: pipelineId,
      stage_id: stageId,
      name: name.trim(),
      is_active: true,
      actions,
    });
    setSaving(false);
    if (error) {
      toast.error('Falha ao criar automação', { description: error.message });
      return;
    }
    toast.success('Automação criada.');
    await onDone();
  };

  return (
    <div className="glass-card space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Nome da automação</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Boas-vindas ao entrar em Follow-Up" className={inputCls} />
        </div>
        <div>
          <span className={labelCls}>Quando o lead entrar na etapa</span>
          <select value={stageId} onChange={(e) => setStageId(e.target.value)} className={inputCls}>
            <option value="">Selecione a etapa…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-3">
        <span className={labelCls}>Ações</span>
        {actions.map((a, i) => (
          <div key={i} className="rounded-lg border border-[rgba(59,130,246,0.15)] bg-white/[0.02] p-3">
            <div className="flex items-center gap-2">
              <select value={a.type} onChange={(e) => setAction(i, { type: e.target.value })} className={inputCls}>
                {ACTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <button onClick={() => removeAction(i)} className="shrink-0 rounded-md p-1.5 text-[var(--color-error)] hover:bg-white/5">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {a.type === 'add_tag' && (
                <select value={String(a.tag_id ?? '')} onChange={(e) => setAction(i, { tag_id: e.target.value })} className={inputCls}>
                  <option value="">Tag…</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {a.type === 'next_action' && (
                <>
                  <select value={String(a.action_type ?? 'followup')} onChange={(e) => setAction(i, { action_type: e.target.value as CrmActionType })} className={inputCls}>
                    {CRM_ACTION_TYPES.map((t) => <option key={t} value={t}>{CRM_ACTION_LABEL[t]}</option>)}
                  </select>
                  <input type="number" min={1} value={String(a.delay_hours ?? 24)} onChange={(e) => setAction(i, { delay_hours: Number(e.target.value) })} placeholder="Prazo (horas)" className={inputCls} />
                  <input value={String(a.note ?? '')} onChange={(e) => setAction(i, { note: e.target.value })} placeholder="Descrição da ação" className={`${inputCls} sm:col-span-2`} />
                </>
              )}
              {a.type === 'set_lead_type' && (
                <select value={String(a.value ?? '')} onChange={(e) => setAction(i, { value: e.target.value })} className={inputCls}>
                  <option value="">Valor…</option>
                  <option value="Lead">Lead</option>
                  <option value="Cliente">Cliente</option>
                </select>
              )}
              {a.type === 'set_temperature' && (
                <select value={String(a.value ?? '')} onChange={(e) => setAction(i, { value: e.target.value })} className={inputCls}>
                  <option value="">Temperatura…</option>
                  <option value="Frio">Frio</option>
                  <option value="Morno">Morno</option>
                  <option value="Quente">Quente</option>
                </select>
              )}
              {a.type === 'send_template' && (
                <select value={String(a.template_id ?? '')} onChange={(e) => setAction(i, { template_id: e.target.value })} className={inputCls}>
                  <option value="">Template aprovado…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {a.type === 'send_text' && (
                <textarea value={String(a.text ?? '')} onChange={(e) => setAction(i, { text: e.target.value })} rows={2} placeholder="Mensagem de texto (sai pelo canal da conversa — Zernio ou UAZAPI; na API oficial exige janela de 24h aberta)" className={`${inputCls} sm:col-span-2 resize-none`} />
              )}
              {a.type === 'assign' && (
                <select value={String(a.user_id ?? '')} onChange={(e) => setAction(i, { user_id: e.target.value })} className={inputCls}>
                  <option value="">Membro da equipe…</option>
                  {operators.map((o) => <option key={o.user_id} value={o.user_id}>{o.email}</option>)}
                </select>
              )}
              {a.type === 'add_to_pipeline' && (
                <>
                  <select
                    value={String(a.pipeline_id ?? '')}
                    onChange={(e) => setAction(i, { pipeline_id: e.target.value, stage_id: '' })}
                    className={inputCls}
                  >
                    <option value="">Funil destino…</option>
                    {pipelines.filter((p) => p.id !== pipelineId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <select value={String(a.stage_id ?? '')} onChange={(e) => setAction(i, { stage_id: e.target.value })} className={inputCls}>
                    <option value="">Etapa destino…</option>
                    {allStages.filter((s) => s.pipeline_id === a.pipeline_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </>
              )}
            </div>
          </div>
        ))}
        <button onClick={addAction} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[rgba(59,130,246,0.3)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
          <Plus className="h-3 w-3" /> Adicionar ação
        </button>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-lg border border-[rgba(59,130,246,0.2)] px-4 py-2 text-sm text-[var(--color-text-secondary)]">
          Cancelar
        </button>
        <button onClick={() => void save()} disabled={saving} className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? 'Salvando…' : 'Salvar automação'}
        </button>
      </div>
    </div>
  );
}
