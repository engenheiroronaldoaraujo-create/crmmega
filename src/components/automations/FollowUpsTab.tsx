// ============================================================================
// Automações → Follow-ups: regras de reengajamento automático.
// Gatilhos: Sem resposta (broadcast oficial) · Inatividade · Sem compra há X.
// Canal: API Oficial (Meta/Zernio, template aprovado) ou UAZAPI (não oficial,
// texto livre) — com aviso de risco de banimento. Motor: check-follow-ups
// (cron 15min); dedup 1 disparo por regra × contato (follow_up_log).
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Plus, Timer, Trash2 } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/app/providers/AuthProvider';
import { useFollowUpRules } from '@/hooks/useFollowUpRules';
import { useTags } from '@/hooks/useTags';
import { useTemplates } from '@/hooks/useTemplates';
import type { FollowUpRule, FollowUpTrigger } from '@/types/campaigns';

const TRIGGER_LABEL: Record<FollowUpTrigger, string> = {
  no_reply: 'Sem resposta (após campanha)',
  inactivity: 'Inatividade na conversa',
  no_purchase: 'Sem compra há X dias',
};

const inputCls =
  'w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

export function FollowUpsTab() {
  const { rules, loading, create, update, remove } = useFollowUpRules();
  const { templates } = useTemplates();
  const { tags } = useTags();
  const { session } = useAuth();
  const [creating, setCreating] = useState(false);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [uazapiOk, setUazapiOk] = useState(false);

  const approvedTemplates = useMemo(() => templates.filter((t) => t.status === 'approved'), [templates]);

  useEffect(() => {
    void getSupabase().from('campaigns').select('id, name').order('created_at', { ascending: false })
      .then(({ data }) => setCampaigns((data ?? []) as { id: string; name: string }[]));
  }, []);

  // UAZAPI disponível? (habilita o canal não oficial no form)
  useEffect(() => {
    if (!session) return;
    void fetch('/api/uazapi-connect', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (res) => {
        const body = (await res.json()) as { configured?: boolean };
        setUazapiOk(Boolean(body.configured));
      })
      .catch(() => setUazapiOk(false));
  }, [session]);

  const templateName = (id: string | null) => templates.find((t) => t.id === id)?.name ?? '—';

  const describe = (r: FollowUpRule): string => {
    const params = r.params ?? {};
    if (r.trigger_condition === 'no_purchase') {
      return `Cliente sem compra há ${Number(params.days) || Math.round(r.delay_hours / 24)} dia(s)`;
    }
    if (r.trigger_condition === 'inactivity') {
      return `Conversa sem movimento há ${r.delay_hours}h`;
    }
    return `Sem resposta após ${r.delay_hours}h`;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Regras verificadas a cada 15 minutos. Cada regra dispara no máximo uma vez por contato.
        </p>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Nova regra
        </button>
      </div>

      {creating && (
        <RuleForm
          templates={approvedTemplates}
          tags={tags}
          campaigns={campaigns}
          uazapiOk={uazapiOk}
          nextOrder={rules.reduce((m, r) => Math.max(m, r.sequence_order), 0) + 1}
          onSave={async (input) => {
            await create(input as Omit<FollowUpRule, 'id' | 'created_at' | 'updated_at'>);
            setCreating(false);
            toast.success('Regra criada.');
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <div className="text-label opacity-60">Carregando…</div>
      ) : rules.length === 0 ? (
        <div className="glass-card p-6 text-sm text-[var(--color-text-secondary)]">
          Nenhuma regra de follow-up. Crie regras por tempo de inatividade, tempo sem compra
          ou sem resposta após campanhas.
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((r) => (
            <div key={r.id} className="glass-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Timer className="h-4 w-4 text-[var(--accent-primary)]" />
                    <span className="font-semibold text-[var(--color-text-primary)]">
                      {TRIGGER_LABEL[r.trigger_condition] ?? r.trigger_condition}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.provider === 'uazapi' ? 'bg-[rgba(45,212,191,0.14)] text-[#2DD4BF]' : 'bg-[rgba(37,211,102,0.14)] text-[#25D366]'}`}>
                      {r.provider === 'uazapi' ? 'UAZAPI (não oficial)' : 'API Oficial'}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.is_active ? 'bg-[rgba(16,185,129,0.12)] text-[#10B981]' : 'bg-white/5 text-[var(--color-text-secondary)]'}`}>
                      {r.is_active ? 'Ativa' : 'Inativa'}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                    {describe(r)} →{' '}
                    {r.provider === 'uazapi'
                      ? `mensagem: "${(r.message_text ?? '').slice(0, 60)}${(r.message_text ?? '').length > 60 ? '…' : ''}"`
                      : `template: ${templateName(r.template_id)}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void update(r.id, { is_active: !r.is_active }).catch((e) => toast.error(e.message))}
                    role="switch"
                    aria-checked={r.is_active}
                    className={`relative h-6 w-11 rounded-full transition-colors ${r.is_active ? 'bg-[var(--accent-primary)]' : 'bg-white/10'}`}
                  >
                    <span className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${r.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                  <button
                    onClick={() => { if (confirm('Excluir esta regra?')) void remove(r.id).catch((e) => toast.error(e.message)); }}
                    className="rounded-md p-1.5 text-[var(--color-error)] transition hover:bg-white/5"
                  >
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

// ---- Form -------------------------------------------------------------------

function RuleForm({
  templates, tags, campaigns, uazapiOk, nextOrder, onSave, onCancel,
}: {
  templates: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
  uazapiOk: boolean;
  nextOrder: number;
  onSave: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [trigger, setTrigger] = useState<FollowUpTrigger>('inactivity');
  const [provider, setProvider] = useState<'zernio' | 'uazapi'>('zernio');
  const [delayHours, setDelayHours] = useState('24');
  const [days, setDays] = useState('30');
  const [templateId, setTemplateId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [temperature, setTemperature] = useState('');
  const [leadType, setLeadType] = useState('');
  const [tagId, setTagId] = useState('');
  const [saving, setSaving] = useState(false);

  // no_reply é reengajamento de broadcast — só existe na API oficial.
  const effectiveProvider = trigger === 'no_reply' ? 'zernio' : provider;

  const save = async () => {
    if (effectiveProvider === 'zernio' && !templateId) {
      toast.error('Selecione um template aprovado da Meta.');
      return;
    }
    if (effectiveProvider === 'uazapi' && !messageText.trim()) {
      toast.error('Escreva a mensagem do follow-up.');
      return;
    }
    const params: Record<string, unknown> = {};
    if (trigger === 'no_purchase') params.days = Number(days) || 30;
    if (temperature) params.temperature = temperature;
    if (leadType) params.lead_type = leadType;
    if (tagId) params.tag_id = tagId;

    setSaving(true);
    try {
      await onSave({
        trigger_condition: trigger,
        delay_hours: trigger === 'no_purchase' ? (Number(days) || 30) * 24 : Math.max(1, Number(delayHours) || 24),
        provider: effectiveProvider,
        template_id: effectiveProvider === 'zernio' ? templateId : null,
        message_text: effectiveProvider === 'uazapi' ? messageText.trim() : null,
        campaign_id: trigger === 'no_reply' && campaignId ? campaignId : null,
        sequence_order: nextOrder,
        is_active: true,
        params,
      });
    } catch (err) {
      toast.error('Falha ao criar regra', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Gatilho</span>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as FollowUpTrigger)} className={inputCls}>
            <option value="inactivity">Tempo de inatividade na conversa</option>
            <option value="no_purchase">Tempo sem comprar produtos</option>
            <option value="no_reply">Sem resposta após campanha</option>
          </select>
        </div>
        {trigger === 'no_purchase' ? (
          <div>
            <span className={labelCls}>Dias sem comprar</span>
            <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className={inputCls} />
          </div>
        ) : (
          <div>
            <span className={labelCls}>{trigger === 'inactivity' ? 'Horas de inatividade' : 'Horas sem resposta'}</span>
            <input type="number" min={1} value={delayHours} onChange={(e) => setDelayHours(e.target.value)} className={inputCls} />
          </div>
        )}
      </div>

      {trigger === 'no_reply' && (
        <div>
          <span className={labelCls}>Campanha (opcional — vazio = todas)</span>
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={inputCls}>
            <option value="">Todas as campanhas</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {/* Canal */}
      <div>
        <span className={labelCls}>Canal de envio</span>
        <div className="flex flex-wrap gap-2">
          <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${effectiveProvider === 'zernio' ? 'border-[#3B82F6] bg-[rgba(59,130,246,0.08)]' : 'border-[rgba(59,130,246,0.2)]'}`}>
            <input type="radio" checked={effectiveProvider === 'zernio'} onChange={() => setProvider('zernio')} className="accent-[var(--accent-primary)]" />
            API Oficial (Meta) — template aprovado
          </label>
          <label
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${!uazapiOk || trigger === 'no_reply' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${effectiveProvider === 'uazapi' ? 'border-[#2DD4BF] bg-[rgba(45,212,191,0.08)]' : 'border-[rgba(59,130,246,0.2)]'}`}
            title={!uazapiOk ? 'Conecte a UAZAPI em Configurações → Canais' : trigger === 'no_reply' ? 'Reengajamento de campanha usa a API oficial' : undefined}
          >
            <input
              type="radio"
              disabled={!uazapiOk || trigger === 'no_reply'}
              checked={effectiveProvider === 'uazapi'}
              onChange={() => setProvider('uazapi')}
              className="accent-[#2DD4BF]"
            />
            API Não Oficial (UAZAPI) — texto livre
          </label>
        </div>
        {effectiveProvider === 'uazapi' && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-2 text-sm text-[#FBBF24]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Ao ativar follow-ups com a UAZAPI (API Não Oficial) o risco de banimento do número é maior.
          </div>
        )}
      </div>

      {effectiveProvider === 'zernio' ? (
        <div>
          <span className={labelCls}>Template aprovado da Meta</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputCls}>
            <option value="">Selecione…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      ) : (
        <div>
          <span className={labelCls}>Mensagem do follow-up</span>
          <textarea value={messageText} onChange={(e) => setMessageText(e.target.value)} rows={3} placeholder="Texto enviado pelo número UAZAPI…" className={`${inputCls} resize-none`} />
        </div>
      )}

      {/* Filtros opcionais */}
      <div>
        <span className={labelCls}>Filtros opcionais (regras condicionais)</span>
        <div className="grid gap-2 sm:grid-cols-3">
          <select value={temperature} onChange={(e) => setTemperature(e.target.value)} className={inputCls}>
            <option value="">Qualquer temperatura</option>
            <option value="Frio">Frio</option>
            <option value="Morno">Morno</option>
            <option value="Quente">Quente</option>
          </select>
          <select value={leadType} onChange={(e) => setLeadType(e.target.value)} className={inputCls}>
            <option value="">Lead ou Cliente</option>
            <option value="Lead">Somente Leads</option>
            <option value="Cliente">Somente Clientes</option>
          </select>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className={inputCls}>
            <option value="">Qualquer tag</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-lg border border-[rgba(59,130,246,0.2)] px-4 py-2 text-sm text-[var(--color-text-secondary)]">
          Cancelar
        </button>
        <button onClick={() => void save()} disabled={saving} className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? 'Salvando…' : 'Criar regra'}
        </button>
      </div>
    </div>
  );
}
