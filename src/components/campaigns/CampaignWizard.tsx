import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { useTemplates } from '@/hooks/useTemplates';
import { useTags } from '@/hooks/useTags';
import { useCampaigns } from '@/hooks/useCampaigns';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import type { AudienceFilter, VariableSource } from '@/types/campaigns';
import type { Pipeline, Stage } from '@/types/crm';

interface CampaignWizardProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type AudienceMode = 'all' | 'tags' | 'custom' | 'funnel';

// Fontes de preenchimento por variável. Nome/valor fixo vão pelo broadcast do
// Zernio; os campos do negócio (deal) forçam envio 1:1 no dispatcher, com o
// valor resolvido por destinatário a partir do deal mais recente do contato.
type DealField = 'title' | 'products' | 'value' | 'last_purchase_at';
type VarChoice =
  | { kind: 'name'; fallback: string }
  | { kind: 'literal'; value: string }
  | { kind: 'deal'; field: DealField; fallback: string };

const DEAL_FIELD_OPTIONS: Array<{ field: DealField; label: string; hint: string }> = [
  { field: 'title', label: 'Nome do negócio', hint: 'Título do negócio mais recente do lead' },
  { field: 'products', label: 'Produtos do negócio', hint: 'Nomes dos produtos, separados por vírgula' },
  { field: 'value', label: 'Valor da compra', hint: 'Valor do negócio formatado em R$' },
  { field: 'last_purchase_at', label: 'Data da última compra', hint: 'No formato dd/mm/aaaa' },
];

function countTemplateVariables(body: string): number {
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
  return new Set(matches).size;
}

const STEPS = ['Identidade', 'Audiência', 'Agendamento'] as const;

export function CampaignWizard({ open, onClose, onSaved }: CampaignWizardProps) {
  const { templates } = useTemplates();
  const { tags } = useTags();
  const { createAndQueue, previewAudience } = useCampaigns();

  const approvedTemplates = useMemo(
    () => templates.filter((t) => t.status === 'approved'),
    [templates],
  );

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  // Multi-número: canal (número oficial via Zernio) que dispara o broadcast.
  // Com um único canal ativo, ele é selecionado automaticamente e o seletor
  // fica oculto.
  const [zernioChannels, setZernioChannels] = useState<
    Array<{ id: string; label: string; phone: string | null }>
  >([]);
  const [channelId, setChannelId] = useState<string>('');
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('all');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [customFieldKey, setCustomFieldKey] = useState('');
  const [customFieldValue, setCustomFieldValue] = useState('');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [funnelPipelineId, setFunnelPipelineId] = useState<string>('');
  const [selectedStageIds, setSelectedStageIds] = useState<Set<string>>(new Set());
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [scheduleNow, setScheduleNow] = useState(true);
  const [scheduleAt, setScheduleAt] = useState(''); // datetime-local value
  const [submitting, setSubmitting] = useState(false);

  const [varChoices, setVarChoices] = useState<Record<string, VarChoice>>({});

  const selectedTemplate = useMemo(
    () => approvedTemplates.find((t) => t.id === templateId) ?? null,
    [approvedTemplates, templateId],
  );

  const varCount = useMemo(
    () => (selectedTemplate ? countTemplateVariables(selectedTemplate.body) : 0),
    [selectedTemplate],
  );

  // Ao trocar de template, zera as escolhas (defaults: valor fixo vazio).
  useEffect(() => {
    setVarChoices({});
  }, [templateId]);

  const varsOk = useMemo(() => {
    for (let i = 1; i <= varCount; i++) {
      const ch = varChoices[String(i)];
      if (!ch) return false;
      if (ch.kind === 'literal' && ch.value.trim() === '') return false;
    }
    return true;
  }, [varCount, varChoices]);

  const variableMapping = useMemo(() => {
    const out: Record<string, VariableSource> = {};
    for (let i = 1; i <= varCount; i++) {
      const ch = varChoices[String(i)];
      if (!ch) continue;
      if (ch.kind === 'name') {
        out[String(i)] = {
          source: 'contact_field',
          field: 'name',
          ...(ch.fallback.trim() !== '' ? { fallback: ch.fallback.trim() } : {}),
        };
      } else if (ch.kind === 'deal') {
        out[String(i)] = {
          source: 'deal_field',
          field: ch.field,
          ...(ch.fallback.trim() !== '' ? { fallback: ch.fallback.trim() } : {}),
        };
      } else {
        out[String(i)] = { source: 'literal', value: ch.value.trim() };
      }
    }
    return out;
  }, [varCount, varChoices]);

  useEffect(() => {
    if (!open) return;
    // Fresh state every time the wizard is opened.
    setStep(0);
    setName('');
    setTemplateId('');
    setAudienceMode('all');
    setSelectedTagIds(new Set());
    setCustomFieldKey('');
    setCustomFieldValue('');
    setFunnelPipelineId('');
    setSelectedStageIds(new Set());
    setStages([]);
    setAudienceCount(null);
    setScheduleNow(true);
    setScheduleAt('');
    setVarChoices({});
  }, [open]);

  // Carrega os funis comerciais quando o wizard abre.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase()
        .from('pipelines')
        .select('*')
        .eq('kind', 'comercial')
        .order('position');
      if (!cancelled) setPipelines((data ?? []) as Pipeline[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Carrega as etapas do funil escolhido; limpa a seleção de etapas ao trocar.
  useEffect(() => {
    if (!funnelPipelineId) {
      setStages([]);
      setSelectedStageIds(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase()
        .from('stages')
        .select('*')
        .eq('pipeline_id', funnelPipelineId)
        .order('position');
      if (!cancelled) setStages((data ?? []) as Stage[]);
    })();
    setSelectedStageIds(new Set());
    return () => {
      cancelled = true;
    };
  }, [funnelPipelineId]);

  // Carrega os números oficiais ativos da org para o seletor de canal.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .schema('whatsapp_hub')
        .from('channels')
        .select('id, label, phone')
        .eq('provider', 'zernio')
        .eq('is_active', true)
        .order('created_at');
      if (cancelled) return;
      const rows = (data ?? []) as Array<{ id: string; label: string; phone: string | null }>;
      setZernioChannels(rows);
      setChannelId((prev) => prev || (rows[0]?.id ?? ''));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const currentFilter: AudienceFilter = useMemo(() => {
    if (audienceMode === 'all') return { all: true };
    if (audienceMode === 'tags') return { tag_ids: Array.from(selectedTagIds) };
    if (audienceMode === 'custom' && customFieldKey.trim() && customFieldValue.trim()) {
      return { custom_fields: { [customFieldKey.trim()]: customFieldValue.trim() } };
    }
    if (audienceMode === 'funnel' && funnelPipelineId) {
      // Sem etapas marcadas = funil inteiro; com etapas = só as escolhidas.
      return selectedStageIds.size > 0
        ? { pipeline_id: funnelPipelineId, stage_ids: Array.from(selectedStageIds) }
        : { pipeline_id: funnelPipelineId };
    }
    return {};
  }, [audienceMode, selectedTagIds, customFieldKey, customFieldValue, funnelPipelineId, selectedStageIds]);

  const refreshPreview = async () => {
    try {
      const count = await previewAudience(currentFilter);
      setAudienceCount(count);
    } catch (err) {
      toast.error('Falha ao calcular audiência', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  useEffect(() => {
    if (step !== 1) return;
    // Debounce the preview so fast toggling doesn't hammer the DB.
    const t = setTimeout(() => {
      void refreshPreview();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, audienceMode, selectedTagIds, customFieldKey, customFieldValue, funnelPipelineId, selectedStageIds]);

  // Agendamento no passado dispararia imediatamente (o cron promove
  // scheduled→sending quando scheduled_at <= now), o que surpreende o usuário.
  const scheduleInPast = !scheduleNow && !!scheduleAt && new Date(scheduleAt).getTime() <= Date.now();

  const canNext =
    (step === 0 && name.trim() && templateId && varsOk) ||
    (step === 1 && (audienceCount ?? 0) > 0);

  const nextStep = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const prevStep = () => setStep((s) => Math.max(0, s - 1));

  const handleCreate = async () => {
    if (!selectedTemplate) return;

    setSubmitting(true);
    try {
      const result = await createAndQueue({
        name: name.trim(),
        template_id: selectedTemplate.id,
        audience_filter: currentFilter,
        variable_mapping: variableMapping,
        scheduled_at: scheduleNow ? null : new Date(scheduleAt).toISOString(),
        channel_id: channelId || null,
      });
      if (result) {
        toast.success(`Campanha criada com ${result.queued} destinatário${result.queued === 1 ? '' : 's'}.`);
        onSaved?.();
        onClose();
      }
    } catch (err) {
      toast.error('Falha ao criar campanha', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Nova campanha" widthClass="max-w-3xl" opaque>
      <ol className="grid grid-cols-3 gap-2 mb-6">
        {STEPS.map((label, idx) => {
          const state = idx < step ? 'done' : idx === step ? 'current' : 'pending';
          return (
            <li
              key={label}
              className={cn(
                'flex items-center gap-2 rounded-lg p-2 border text-xs font-semibold uppercase tracking-wide',
                state === 'current' && 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.08)] text-[var(--color-text-primary)]',
                state === 'done' && 'border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.04)] text-[var(--color-text-secondary)]',
                state === 'pending' && 'border-[rgba(59,130,246,0.12)] text-[var(--color-text-secondary)] opacity-60',
              )}
            >
              <span
                className={cn(
                  'h-5 w-5 rounded-full flex items-center justify-center text-[10px]',
                  state === 'current' && 'bg-[var(--accent-primary)] text-white',
                  state === 'done' && 'bg-[var(--color-success)] text-white',
                  state === 'pending' && 'bg-white/5',
                )}
              >
                {state === 'done' ? <Check className="h-3 w-3" /> : idx + 1}
              </span>
              <span className="truncate">{label}</span>
            </li>
          );
        })}
      </ol>

      {/* Step 1 — Identidade */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="c_name">Nome da campanha</Label>
            <Input
              id="c_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: promo-black-friday-2026"
              disabled={submitting}
            />
          </div>
          {zernioChannels.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="c_channel">Número de disparo</Label>
              <select
                id="c_channel"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                disabled={submitting}
                className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
              >
                {zernioChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.label}{ch.phone ? ` · ${ch.phone}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="c_template">Template aprovado</Label>
            {approvedTemplates.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] opacity-80">
                Nenhum template aprovado. Vá em Templates → submeta um para a Meta e aguarde aprovação.
              </p>
            ) : (
              <select
                id="c_template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={submitting}
                className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
              >
                <option value="">— selecione —</option>
                {approvedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.category} · {t.language}
                  </option>
                ))}
              </select>
            )}
          </div>
          {selectedTemplate && (
            <div className="rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02] p-3 text-xs font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap">
              {selectedTemplate.body}
            </div>
          )}

          {varCount > 0 && (
            <div className="space-y-3 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.02] p-3">
              <div className="text-xs font-semibold text-[var(--color-text-primary)]">
                Variáveis do template
              </div>
              {Array.from({ length: varCount }, (_, idx) => {
                const i = String(idx + 1);
                const choice = varChoices[i];
                const hint = selectedTemplate?.variables?.[i];
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 font-mono text-xs text-[var(--accent-secondary)]">{`{{${i}}}`}</span>
                    <select
                      value={choice ? (choice.kind === 'deal' ? `deal:${choice.field}` : choice.kind) : ''}
                      onChange={(e) => {
                        const kind = e.target.value;
                        setVarChoices((cur) => {
                          const next = { ...cur };
                          if (kind === 'name') next[i] = { kind: 'name', fallback: '' };
                          else if (kind === 'literal') next[i] = { kind: 'literal', value: '' };
                          else if (kind.startsWith('deal:'))
                            next[i] = { kind: 'deal', field: kind.slice(5) as DealField, fallback: '' };
                          else delete next[i];
                          return next;
                        });
                      }}
                      disabled={submitting}
                      className="h-9 w-52 shrink-0 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-2 text-xs text-[var(--color-text-primary)]"
                    >
                      <option value="">— preencher com —</option>
                      <option value="name">Nome do contato</option>
                      {DEAL_FIELD_OPTIONS.map((o) => (
                        <option key={o.field} value={`deal:${o.field}`}>
                          {o.label}
                        </option>
                      ))}
                      <option value="literal">Valor fixo p/ todos</option>
                    </select>
                    {choice?.kind === 'literal' && (
                      <Input
                        value={choice.value}
                        onChange={(e) =>
                          setVarChoices((cur) => ({ ...cur, [i]: { kind: 'literal', value: e.target.value } }))
                        }
                        placeholder={hint ? `Ex.: ${hint}` : 'Valor enviado a todos'}
                        disabled={submitting}
                        className="h-9 text-xs"
                      />
                    )}
                    {choice?.kind === 'name' && (
                      <Input
                        value={choice.fallback}
                        onChange={(e) =>
                          setVarChoices((cur) => ({ ...cur, [i]: { kind: 'name', fallback: e.target.value } }))
                        }
                        placeholder="Fallback se o contato não tiver nome (ex.: Cliente)"
                        disabled={submitting}
                        className="h-9 text-xs"
                      />
                    )}
                    {choice?.kind === 'deal' && (
                      <Input
                        value={choice.fallback}
                        onChange={(e) =>
                          setVarChoices((cur) => ({
                            ...cur,
                            [i]: { kind: 'deal', field: choice.field, fallback: e.target.value },
                          }))
                        }
                        placeholder={`Fallback se o lead não tiver o dado (${DEAL_FIELD_OPTIONS.find((o) => o.field === choice.field)?.hint ?? ''})`}
                        disabled={submitting}
                        className="h-9 text-xs"
                      />
                    )}
                  </div>
                );
              })}
              {Object.values(varChoices).some(
                (ch) => (ch.kind === 'name' || ch.kind === 'deal') && ch.fallback.trim() === '',
              ) && (
                <p className="text-[11px] text-[var(--color-text-secondary)] opacity-80">
                  Sem fallback, contatos sem o dado preenchido não recebem a campanha.
                </p>
              )}
              {Object.values(varChoices).some((ch) => ch.kind === 'deal') && (
                <p className="text-[11px] text-[var(--color-text-secondary)] opacity-80">
                  Variáveis de negócio usam o negócio mais recente de cada lead e são
                  enviadas individualmente (pode levar mais tempo em audiências grandes).
                </p>
              )}
              {!varsOk && (
                <p className="text-[11px] text-[#FBBF24]">
                  Defina como preencher cada variável para continuar.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 2 — Audiência */}
      {step === 1 && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {(['all', 'tags', 'custom', 'funnel'] as AudienceMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAudienceMode(mode)}
                className={cn(
                  'p-3 rounded-lg border text-left text-sm font-medium transition-all',
                  audienceMode === mode
                    ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.08)] text-[var(--color-text-primary)]'
                    : 'border-[rgba(59,130,246,0.12)] bg-white/[0.02] text-[var(--color-text-secondary)]',
                )}
              >
                {mode === 'all' && 'Todos os contatos'}
                {mode === 'tags' && 'Por tags'}
                {mode === 'custom' && 'Por campo custom'}
                {mode === 'funnel' && 'Por funil/etapa'}
              </button>
            ))}
          </div>

          {audienceMode === 'tags' && (
            <div className="space-y-2">
              <Label>Tags (OR entre elas)</Label>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => {
                  const active = selectedTagIds.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() =>
                        setSelectedTagIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        })
                      }
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs',
                        active
                          ? 'bg-white/10 text-[var(--color-text-primary)]'
                          : 'bg-white/[0.03] text-[var(--color-text-secondary)]',
                      )}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {audienceMode === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="cf_key">Chave do campo</Label>
                <Input
                  id="cf_key"
                  value={customFieldKey}
                  onChange={(e) => setCustomFieldKey(e.target.value)}
                  placeholder="cidade"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cf_val">Valor exato</Label>
                <Input
                  id="cf_val"
                  value={customFieldValue}
                  onChange={(e) => setCustomFieldValue(e.target.value)}
                  placeholder="São Paulo"
                />
              </div>
            </div>
          )}

          {audienceMode === 'funnel' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="c_funnel">Funil</Label>
                {pipelines.length === 0 ? (
                  <p className="text-sm text-[var(--color-text-secondary)] opacity-80">
                    Nenhum funil comercial encontrado. Crie um em Funil.
                  </p>
                ) : (
                  <select
                    id="c_funnel"
                    value={funnelPipelineId}
                    onChange={(e) => setFunnelPipelineId(e.target.value)}
                    className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
                  >
                    <option value="">— selecione um funil —</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {funnelPipelineId && (
                <div className="space-y-2">
                  <Label>Etapas (deixe vazio p/ o funil inteiro)</Label>
                  <div className="flex flex-wrap gap-2">
                    {stages.map((s) => {
                      const active = selectedStageIds.has(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            setSelectedStageIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id);
                              else next.add(s.id);
                              return next;
                            })
                          }
                          className={cn(
                            'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs',
                            active
                              ? 'bg-white/10 text-[var(--color-text-primary)]'
                              : 'bg-white/[0.03] text-[var(--color-text-secondary)]',
                          )}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: s.color ?? 'var(--accent-primary)' }}
                          />
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-[rgba(59,130,246,0.15)] bg-[rgba(59,130,246,0.04)] p-4 text-center">
            <div className="text-label">Contatos alcançados</div>
            <div className="text-stat mt-1">{audienceCount ?? '…'}</div>
          </div>

          {audienceMode === 'tags' && selectedTagIds.size === 0 && (
            <p className="text-xs text-[#FBBF24] text-center">
              Selecione pelo menos uma tag para continuar.
            </p>
          )}
          {audienceMode === 'custom' && !(customFieldKey.trim() && customFieldValue.trim()) && (
            <p className="text-xs text-[#FBBF24] text-center">
              Preencha a chave e o valor do campo para continuar.
            </p>
          )}
          {audienceMode === 'funnel' && !funnelPipelineId && (
            <p className="text-xs text-[#FBBF24] text-center">
              Selecione um funil para continuar.
            </p>
          )}
          {audienceCount === 0 && (
            <p className="text-xs text-[var(--color-text-secondary)] text-center">
              Nenhum contato corresponde a este filtro — a campanha não pode avançar.
            </p>
          )}
        </div>
      )}

      {/* Step 3 — Agendamento + Review */}
      {step === 2 && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setScheduleNow(true)}
              className={cn(
                'p-3 rounded-lg border text-left text-sm font-medium',
                scheduleNow
                  ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.08)]'
                  : 'border-[rgba(59,130,246,0.12)] bg-white/[0.02]',
              )}
            >
              Disparar imediatamente
            </button>
            <button
              type="button"
              onClick={() => setScheduleNow(false)}
              className={cn(
                'p-3 rounded-lg border text-left text-sm font-medium',
                !scheduleNow
                  ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.08)]'
                  : 'border-[rgba(59,130,246,0.12)] bg-white/[0.02]',
              )}
            >
              Agendar para depois
            </button>
          </div>
          {!scheduleNow && (
            <div className="space-y-2">
              <Label htmlFor="c_when">Data e hora</Label>
              <Input
                id="c_when"
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              {scheduleAt && scheduleInPast && (
                <p className="text-xs text-[#EF4444]">
                  A data escolhida já passou — escolha um horário futuro (a campanha
                  dispararia imediatamente).
                </p>
              )}
            </div>
          )}

          <div className="rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02] p-4 space-y-2 text-sm">
            <div className="text-label mb-1">Revisão</div>
            <div><span className="text-[var(--color-text-secondary)]">Campanha:</span> <span className="font-mono">{name}</span></div>
            <div><span className="text-[var(--color-text-secondary)]">Template:</span> <span className="font-mono">{selectedTemplate?.name ?? '—'}</span></div>
            <div><span className="text-[var(--color-text-secondary)]">Destinatários:</span> {audienceCount ?? 0}</div>
            <div><span className="text-[var(--color-text-secondary)]">Quando:</span> {scheduleNow ? 'Imediato' : scheduleAt || '—'}</div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-6 mt-4 border-t border-[rgba(59,130,246,0.08)]">
        <Button variant="ghost" onClick={prevStep} disabled={step === 0 || submitting}>
          <ChevronLeft className="h-4 w-4" />
          Anterior
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={nextStep} disabled={!canNext || submitting}>
            Próximo
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={submitting || (!scheduleNow && (!scheduleAt || scheduleInPast))}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Criando...
              </>
            ) : (
              <>Criar campanha</>
            )}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
