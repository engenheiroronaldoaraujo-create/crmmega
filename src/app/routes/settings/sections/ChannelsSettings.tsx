import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Filter,
  Instagram,
  KeyRound,
  Loader2,
  MessageCircle,
  Phone,
  Plus,
  Trash2,
  UserRound,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/app/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';
import { operatorLabel, useOperators } from '@/hooks/useOperators';

// Configurações → Canais. Multi-número: cada linha de whatsapp_hub.channels é
// um número de WhatsApp da organização —
//   · provider 'zernio'  — API oficial da Meta via Zernio (janela de 24h)
//   · provider 'uazapi'  — instância UAZAPI própria (sem janela)
// Cada número pode ser vinculado a um membro: conversas que chegam por aquele
// número são atribuídas automaticamente a ele (sem vínculo, vale o round-robin).

interface ChannelRow {
  id: string;
  provider: 'zernio' | 'uazapi';
  label: string;
  phone: string | null;
  zernio_account_id: string | null;
  assigned_member: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  funnel_auto_add: boolean;
  funnel_pipeline_id: string | null;
  funnel_stage_id: string | null;
}

interface PipelineRow {
  id: string;
  name: string;
}

interface StageRow {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
}

type ConnState = boolean | null; // null = carregando

const ZERNIO_COLOR = '#25D366';
const UAZAPI_COLOR = '#2DD4BF';
const INSTAGRAM_COLOR = '#E1306C';

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1.5 rounded-full bg-[rgba(16,185,129,0.12)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#10B981]'
          : 'inline-flex items-center gap-1.5 rounded-full bg-[rgba(148,163,184,0.12)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--color-text-secondary)]'
      }
    >
      <span
        className={
          active
            ? 'h-1.5 w-1.5 rounded-full bg-[#10B981] shadow-[0_0_6px_rgba(16,185,129,0.8)]'
            : 'h-1.5 w-1.5 rounded-full bg-[#64748B]'
        }
      />
      {active ? 'Ativo' : 'Desativado'}
    </span>
  );
}

// Avatar do membro vinculado — foto se houver, senão iniciais.
function MemberAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} className="h-6 w-6 rounded-full object-cover" />;
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(59,130,246,0.18)] text-[10px] font-bold text-[#60A5FA]">
      {initials || <UserRound className="h-3.5 w-3.5" />}
    </span>
  );
}

export function ChannelsSettings() {
  const { session } = useAuth();
  const { operators } = useOperators();
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [instagram, setInstagram] = useState<ConnState>(null);
  // Plataforma (whatsapp | instagram) por conta Zernio — resolvida ao vivo pela
  // API (o GET /api/zernio-connect devolve isso), sem coluna no banco.
  const [zernioPlatform, setZernioPlatform] = useState<Record<string, string>>({});
  // Funis + etapas para o seletor de auto-add de leads ao funil.
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [stages, setStages] = useState<StageRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showUazapiForm, setShowUazapiForm] = useState(false);
  const [uazForm, setUazForm] = useState({ label: '', serverUrl: '', token: '' });
  const [savingUaz, setSavingUaz] = useState(false);
  const [zernioChoices, setZernioChoices] = useState<{ id: string; name: string }[] | null>(null);
  const [connectingZernio, setConnectingZernio] = useState(false);
  // Zernio API Key (credencial em app_settings) — conecta números oficiais +
  // Instagram. Fica recolhida quando já configurada para não poluir a tela.
  const [showZernioKey, setShowZernioKey] = useState(false);
  const [zernioKey, setZernioKey] = useState('');
  const [zernioKeyExists, setZernioKeyExists] = useState(false);
  const [savingZernioKey, setSavingZernioKey] = useState(false);

  const loadChannels = useCallback(async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .select('id, provider, label, phone, zernio_account_id, assigned_member, is_active, ai_enabled, funnel_auto_add, funnel_pipeline_id, funnel_stage_id')
      .order('created_at');
    if (error) {
      toast.error('Falha ao carregar os números', { description: error.message });
      setChannels([]);
      return;
    }
    setChannels((data ?? []) as ChannelRow[]);
  }, []);

  const loadInstagramStatus = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/zernio-connect', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as {
        connected?: boolean;
        channels?: { zernio_account_id: string | null; platform: string | null }[];
      };
      setInstagram(Boolean(body.connected));
      const map: Record<string, string> = {};
      for (const c of body.channels ?? []) {
        if (c.zernio_account_id && c.platform) map[c.zernio_account_id] = c.platform;
      }
      setZernioPlatform(map);
    } catch {
      setInstagram(false);
    }
  }, [session]);

  const loadZernioKeyStatus = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/credentials?keys=zernio_api_key', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as Record<string, { exists?: boolean }>;
      setZernioKeyExists(Boolean(body?.zernio_api_key?.exists));
    } catch {
      // status informativo — falha aqui não bloqueia a edição.
    }
  }, [session]);

  const loadFunnels = useCallback(async () => {
    const supabase = getSupabase();
    const [pipesQ, stagesQ] = await Promise.all([
      supabase.from('pipelines').select('id, name').order('position'),
      supabase.from('stages').select('id, pipeline_id, name, position').order('position'),
    ]);
    if (!pipesQ.error) setPipelines((pipesQ.data ?? []) as PipelineRow[]);
    if (!stagesQ.error) setStages((stagesQ.data ?? []) as StageRow[]);
  }, []);

  useEffect(() => {
    void loadChannels();
    void loadInstagramStatus();
    void loadZernioKeyStatus();
    void loadFunnels();
  }, [loadChannels, loadInstagramStatus, loadZernioKeyStatus, loadFunnels]);

  const zernioChannels = useMemo(
    () => (channels ?? []).filter((c) => c.provider === 'zernio'),
    [channels],
  );
  const uazapiChannels = useMemo(
    () => (channels ?? []).filter((c) => c.provider === 'uazapi'),
    [channels],
  );
  const activeCount = (channels ?? []).filter((c) => c.is_active).length;

  // Salva a Zernio API Key e já tenta conectar (resolve conta + webhook).
  const saveZernioKey = async () => {
    if (!session || !zernioKey.trim()) return;
    setSavingZernioKey(true);
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ credentials: { zernio_api_key: zernioKey.trim() } }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao salvar a chave.');
      setZernioKeyExists(true);
      setZernioKey('');
      setShowZernioKey(false);
      toast.success('Zernio API Key salva.');
      await connectZernio();
    } catch (err) {
      toast.error('Falha ao salvar a Zernio API Key', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
    } finally {
      setSavingZernioKey(false);
    }
  };

  // Vincula/desvincula o membro responsável pelo número (atribuição automática).
  const setAssignedMember = async (channel: ChannelRow, userId: string | null) => {
    setBusy(channel.id);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .update({ assigned_member: userId })
      .eq('id', channel.id);
    setBusy(null);
    if (error) {
      toast.error('Falha ao vincular membro', { description: error.message });
      return;
    }
    toast.success(userId ? 'Membro vinculado ao número.' : 'Vínculo removido.');
    void loadChannels();
  };

  // Liga/desliga o agente de IA neste número (refina o toggle global da IA).
  const toggleChannelAi = async (channel: ChannelRow) => {
    setBusy(channel.id);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .update({ ai_enabled: !channel.ai_enabled })
      .eq('id', channel.id);
    setBusy(null);
    if (error) {
      toast.error('Falha ao atualizar a IA do número', { description: error.message });
      return;
    }
    toast.success(
      channel.ai_enabled
        ? 'IA desligada neste número — conversas novas vão direto para o humano.'
        : 'IA ligada neste número.',
    );
    void loadChannels();
  };

  // Atualiza a config de auto-add ao funil deste canal (patch parcial).
  const updateChannelFunnel = async (
    channel: ChannelRow,
    patch: Partial<Pick<ChannelRow, 'funnel_auto_add' | 'funnel_pipeline_id' | 'funnel_stage_id'>>,
  ) => {
    setBusy(channel.id);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .update(patch)
      .eq('id', channel.id);
    setBusy(null);
    if (error) {
      toast.error('Falha ao atualizar o funil do canal', { description: error.message });
      return;
    }
    void loadChannels();
  };

  const firstStageOf = (pipelineId: string | null): string | null => {
    if (!pipelineId) return null;
    const s = stages
      .filter((x) => x.pipeline_id === pipelineId)
      .sort((a, b) => a.position - b.position)[0];
    return s?.id ?? null;
  };

  // Liga/desliga o auto-add. Ao ligar, pré-seleciona o 1º funil e sua 1ª etapa.
  const toggleFunnelAutoAdd = async (channel: ChannelRow) => {
    if (channel.funnel_auto_add) {
      await updateChannelFunnel(channel, { funnel_auto_add: false });
      return;
    }
    const pipelineId = channel.funnel_pipeline_id ?? pipelines[0]?.id ?? null;
    const stageId = channel.funnel_stage_id ?? firstStageOf(pipelineId);
    if (!pipelineId || !stageId) {
      toast.error('Crie um funil com ao menos uma etapa antes de ativar.');
      return;
    }
    await updateChannelFunnel(channel, {
      funnel_auto_add: true,
      funnel_pipeline_id: pipelineId,
      funnel_stage_id: stageId,
    });
  };

  const toggleActive = async (channel: ChannelRow) => {
    setBusy(channel.id);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .update({ is_active: !channel.is_active })
      .eq('id', channel.id);
    setBusy(null);
    if (error) {
      toast.error('Falha ao atualizar o número', { description: error.message });
      return;
    }
    void loadChannels();
  };

  // Plataforma resolvida do mapa (só para canais Zernio com account_id).
  const platformOf = (channel: ChannelRow): string | null =>
    channel.zernio_account_id ? (zernioPlatform[channel.zernio_account_id] ?? null) : null;

  // Apaga definitivamente a instância/canal (não só desativa). As conversas já
  // recebidas permanecem no inbox — apenas o vínculo do número/conta é removido.
  const deleteChannel = async (channel: ChannelRow) => {
    const isUazapi = channel.provider === 'uazapi';
    const kind = isUazapi
      ? 'instância UAZAPI'
      : platformOf(channel) === 'instagram'
        ? 'conta do Instagram'
        : 'número do WhatsApp';
    if (
      !window.confirm(
        `Apagar a ${kind} "${channel.label}"? Esta ação é irreversível — para usar de novo será preciso reconectar.`,
      )
    ) {
      return;
    }
    setBusy(channel.id);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .delete()
      .eq('id', channel.id);
    setBusy(null);
    if (error) {
      toast.error('Falha ao apagar o canal', { description: error.message });
      return;
    }
    toast.success(`${isUazapi ? 'Instância' : 'Canal'} apagado.`);
    void loadChannels();
    void loadInstagramStatus();
  };

  // Conecta/reconecta números da conta Zernio (a API Key precisa estar salva).
  // Com várias contas, o backend devolve needsSelection.
  const connectZernio = async (accountId?: string) => {
    if (!session) return;
    setConnectingZernio(true);
    try {
      const res = await fetch('/api/zernio-connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(accountId ? { accountId } : {}),
      });
      const body = await res.json();
      if (res.ok && body.needsSelection) {
        setZernioChoices(body.accounts ?? []);
        return;
      }
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao conectar o número no Zernio.');
      }
      setZernioChoices(null);
      toast.success('Número Zernio conectado.');
      void loadChannels();
      void loadInstagramStatus();
    } catch (err) {
      toast.error('Falha ao conectar via Zernio', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
    } finally {
      setConnectingZernio(false);
    }
  };

  // Cria (ou revalida) uma instância UAZAPI como canal da org.
  const saveUazapiChannel = async () => {
    if (!session) return;
    setSavingUaz(true);
    try {
      const res = await fetch('/api/uazapi-connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          label: uazForm.label.trim() || undefined,
          serverUrl: uazForm.serverUrl.trim(),
          token: uazForm.token.trim(),
        }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        message?: string;
        webhookWarning?: string;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao conectar a instância UAZAPI.');
      }
      if (body.webhookWarning) {
        toast.warning('Instância salva, mas o webhook não pôde ser cadastrado automaticamente.', {
          description: body.webhookWarning,
        });
      } else {
        toast.success('Instância UAZAPI conectada e webhook cadastrado.');
      }
      setShowUazapiForm(false);
      setUazForm({ label: '', serverUrl: '', token: '' });
    } catch (err) {
      toast.error('Falha ao conectar a UAZAPI', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
    } finally {
      // Sempre atualiza a lista — o canal pode ter sido inserido no banco
      // mesmo que o cadastro do webhook tenha falhado.
      void loadChannels();
      setSavingUaz(false);
    }
  };

  const findOperator = (userId: string | null) =>
    userId ? operators.find((o) => o.user_id === userId) : undefined;

  // Card de um número — usado nas duas seções (Zernio e UAZAPI).
  const renderChannelCard = (channel: ChannelRow) => {
    const owner = findOperator(channel.assigned_member);
    const isInstagram = platformOf(channel) === 'instagram';
    const accent = isInstagram
      ? INSTAGRAM_COLOR
      : channel.provider === 'uazapi'
        ? UAZAPI_COLOR
        : ZERNIO_COLOR;
    return (
      <div
        key={channel.id}
        className="glass-card p-4"
        style={{ borderLeft: `3px solid ${channel.is_active ? accent : 'rgba(148,163,184,0.3)'}` }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-[var(--color-text-primary)]">
                {channel.label}
              </span>
              <StatusBadge active={channel.is_active} />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              {isInstagram ? (
                <>
                  <Instagram className="h-3 w-3 shrink-0" style={{ color: INSTAGRAM_COLOR }} />
                  <span style={{ color: INSTAGRAM_COLOR }}>Instagram</span>
                </>
              ) : (
                <>
                  <Phone className="h-3 w-3 shrink-0" />
                  <span className="font-mono">{channel.phone ?? 'número não identificado'}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void toggleActive(channel)}
              disabled={busy === channel.id}
              className="rounded-lg border border-[rgba(59,130,246,0.25)] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)] disabled:opacity-50"
            >
              {channel.is_active ? 'Desativar' : 'Reativar'}
            </button>
            <button
              onClick={() => void deleteChannel(channel)}
              disabled={busy === channel.id}
              title="Apagar definitivamente"
              aria-label="Apagar definitivamente"
              className="rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] p-2 text-[#F87171] transition hover:border-[#F87171] hover:bg-[rgba(239,68,68,0.16)] disabled:opacity-50"
            >
              {busy === channel.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Operador responsável — conversas deste número vão direto para ele. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[rgba(59,130,246,0.08)] pt-3">
          {owner ? (
            <MemberAvatar name={operatorLabel(owner)} avatarUrl={owner.avatar_url} />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-[rgba(148,163,184,0.35)]">
              <UserRound className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
            </span>
          )}
          <select
            value={channel.assigned_member ?? ''}
            disabled={busy === channel.id}
            onChange={(e) => void setAssignedMember(channel, e.target.value || null)}
            className="min-w-0 flex-1 rounded-lg border border-[rgba(59,130,246,0.2)] bg-[rgba(15,18,35,0.8)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
            title="Operador responsável — conversas deste número são atribuídas a ele"
          >
            <option value="">Sem operador fixo (round-robin da equipe)</option>
            {operators.map((op) => (
              <option key={op.user_id} value={op.user_id}>
                {operatorLabel(op)}
              </option>
            ))}
          </select>
        </div>

        {/* IA por número — refina o toggle global (Configurações → Agente IA). */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[rgba(59,130,246,0.08)] pt-3">
          <Bot
            className="h-4 w-4 shrink-0"
            style={{ color: channel.ai_enabled ? '#60A5FA' : 'var(--color-text-secondary)' }}
          />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">
              {isInstagram ? 'Agente de IA neste canal' : 'Agente de IA neste número'}
            </span>
            {!channel.ai_enabled ? (
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                Conversas novas vão direto para o operador vinculado (ou rodízio da equipe).
              </p>
            ) : null}
          </div>
          <button
            role="switch"
            aria-checked={channel.ai_enabled}
            onClick={() => void toggleChannelAi(channel)}
            disabled={busy === channel.id}
            className="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50"
            style={{
              background: channel.ai_enabled ? 'var(--accent-primary)' : 'rgba(148,163,184,0.3)',
            }}
            title={channel.ai_enabled ? 'IA ligada neste número' : 'IA desligada neste número'}
          >
            <span
              className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
              style={{ left: channel.ai_enabled ? '18px' : '2px' }}
            />
          </button>
        </div>

        {/* Auto-add ao funil — todo lead que entrar em contato vira um card no
            funil/etapa escolhidos. Desligado por padrão. */}
        <div className="mt-3 border-t border-[rgba(59,130,246,0.08)] pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter
              className="h-4 w-4 shrink-0"
              style={{ color: channel.funnel_auto_add ? '#34D399' : 'var(--color-text-secondary)' }}
            />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium text-[var(--color-text-primary)]">
                Adicionar leads ao funil automaticamente
              </span>
              {!channel.funnel_auto_add ? (
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  Todo contato novo que chegar por aqui vira um card no funil escolhido.
                </p>
              ) : null}
            </div>
            <button
              role="switch"
              aria-checked={channel.funnel_auto_add}
              onClick={() => void toggleFunnelAutoAdd(channel)}
              disabled={busy === channel.id}
              className="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50"
              style={{
                background: channel.funnel_auto_add ? '#10B981' : 'rgba(148,163,184,0.3)',
              }}
              title={channel.funnel_auto_add ? 'Auto-add ligado' : 'Auto-add desligado'}
            >
              <span
                className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                style={{ left: channel.funnel_auto_add ? '18px' : '2px' }}
              />
            </button>
          </div>

          {channel.funnel_auto_add ? (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--color-text-secondary)]">Funil</span>
                <select
                  value={channel.funnel_pipeline_id ?? ''}
                  disabled={busy === channel.id}
                  onChange={(e) =>
                    void updateChannelFunnel(channel, {
                      funnel_pipeline_id: e.target.value || null,
                      funnel_stage_id: firstStageOf(e.target.value || null),
                    })
                  }
                  className="rounded-lg border border-[rgba(59,130,246,0.2)] bg-[rgba(15,18,35,0.8)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
                >
                  {pipelines.length === 0 ? (
                    <option value="">Nenhum funil criado</option>
                  ) : null}
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--color-text-secondary)]">Etapa</span>
                <select
                  value={channel.funnel_stage_id ?? ''}
                  disabled={busy === channel.id || !channel.funnel_pipeline_id}
                  onChange={(e) =>
                    void updateChannelFunnel(channel, { funnel_stage_id: e.target.value || null })
                  }
                  className="rounded-lg border border-[rgba(59,130,246,0.2)] bg-[rgba(15,18,35,0.8)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
                >
                  {stages
                    .filter((s) => s.pipeline_id === channel.funnel_pipeline_id)
                    .sort((a, b) => a.position - b.position)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const loading = channels === null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <div className="text-label">Canais</div>
        <h2 className="text-xl font-bold text-display">Números de WhatsApp</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Cada operador pode ter o próprio número. Vincule um operador a um número e as
          conversas que chegarem por ele serão atribuídas automaticamente.
        </p>
      </header>

      {/* Resumo — quantos números por provedor */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card p-4">
          <div className="text-label">Ativos</div>
          <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)]">
            {loading ? '—' : activeCount}
          </div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            de {loading ? '—' : channels.length} números
          </div>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-1.5 text-label">
            <MessageCircle className="h-3 w-3" style={{ color: ZERNIO_COLOR }} /> Oficial
          </div>
          <div className="mt-1 text-2xl font-extrabold" style={{ color: ZERNIO_COLOR }}>
            {loading ? '—' : zernioChannels.length}
          </div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">via Zernio (Meta)</div>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-1.5 text-label">
            <Zap className="h-3 w-3" style={{ color: UAZAPI_COLOR }} /> UAZAPI
          </div>
          <div className="mt-1 text-2xl font-extrabold" style={{ color: UAZAPI_COLOR }}>
            {loading ? '—' : uazapiChannels.length}
          </div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">sem janela de 24h</div>
        </div>
      </div>

      {/* ── Zernio — WhatsApp Oficial + Instagram (card único) ── */}
      <section>
        <div className="glass-card space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                style={{ borderColor: 'rgba(37,211,102,0.25)', background: 'rgba(37,211,102,0.08)' }}
              >
                <MessageCircle className="h-5 w-5" style={{ color: ZERNIO_COLOR }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Zernio · WhatsApp Oficial e Instagram
                </h3>
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  Os canais são conectados e gerenciados no painel do Zernio — aqui você só
                  informa a API Key.
                </p>
              </div>
            </div>
            {/* Resumo do que a chave está trazendo para o CRM */}
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(37,211,102,0.1)] px-2.5 py-1 text-[11px] font-semibold" style={{ color: ZERNIO_COLOR }}>
                <MessageCircle className="h-3 w-3" />
                {loading ? '—' : `${zernioChannels.filter((c) => c.is_active).length} de ${zernioChannels.length}`} números ativos
              </span>
              <span
                className={
                  instagram
                    ? 'inline-flex items-center gap-1.5 rounded-full bg-[rgba(225,48,108,0.1)] px-2.5 py-1 text-[11px] font-semibold text-[#E1306C]'
                    : 'inline-flex items-center gap-1.5 rounded-full bg-[rgba(148,163,184,0.1)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]'
                }
              >
                <Instagram className="h-3 w-3" />
                {instagram === null ? '…' : instagram ? 'Instagram conectado' : 'Instagram não conectado'}
              </span>
            </div>
          </div>

          {/* Zernio API Key — única ação disponível no CRM */}
          <div className="rounded-xl border border-[rgba(59,130,246,0.15)] bg-white/[0.02] p-4">
            <button
              onClick={() => setShowZernioKey((v) => !v)}
              className="flex w-full items-center gap-3 text-left"
            >
              <KeyRound className="h-4 w-4 shrink-0 text-[#60A5FA]" />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  Zernio API Key
                </span>
                <span
                  className={
                    zernioKeyExists
                      ? 'ml-2 text-xs text-[#10B981]'
                      : 'ml-2 text-xs text-[#F59E0B]'
                  }
                >
                  {zernioKeyExists ? '· configurada' : '· pendente'}
                </span>
              </div>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-[var(--color-text-secondary)] transition-transform ${showZernioKey ? 'rotate-180' : ''}`}
              />
            </button>
            {showZernioKey ? (
              <div className="mt-3 space-y-3 border-t border-[rgba(59,130,246,0.08)] pt-3">
                <input
                  value={zernioKey}
                  onChange={(e) => setZernioKey(e.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder={zernioKeyExists ? '•••••••••••• (configurada)' : 'Cole a Zernio API Key'}
                  className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Ao salvar, o CRM sincroniza os números oficiais e o Instagram da sua conta
                    Zernio e cadastra o webhook.
                  </p>
                  <button
                    onClick={() => void saveZernioKey()}
                    disabled={!zernioKey.trim() || savingZernioKey || connectingZernio}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    {savingZernioKey || connectingZernio ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Salvar e sincronizar
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Seletor de conta Zernio (API Key com várias contas WhatsApp) */}
          {zernioChoices ? (
            <div className="rounded-xl border border-[rgba(59,130,246,0.15)] bg-white/[0.02] p-4">
              <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Escolha a conta WhatsApp para conectar
              </h4>
              <div className="mt-3 space-y-2">
                {zernioChoices.map((acc) => (
                  <button
                    key={acc.id}
                    onClick={() => void connectZernio(acc.id)}
                    disabled={connectingZernio}
                    className="flex w-full items-center justify-between rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.02] p-3 text-left text-sm text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)]"
                  >
                    <span className="truncate">{acc.name}</span>
                    <span className="ml-3 shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">
                      {acc.id}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Números oficiais trazidos pela chave */}
          {loading ? (
            <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando números...
            </div>
          ) : zernioChannels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-4 text-sm text-[var(--color-text-secondary)]">
              {zernioKeyExists
                ? 'Nenhum número oficial sincronizado ainda. Conecte o WhatsApp no painel do Zernio — ele aparecerá aqui.'
                : 'Configure a Zernio API Key acima para sincronizar os números da sua conta Zernio.'}
            </div>
          ) : (
            <div className="space-y-3">{zernioChannels.map(renderChannelCard)}</div>
          )}
        </div>
      </section>

      {/* ── UAZAPI (card único) ── */}
      <section>
        <div className="glass-card space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                style={{ borderColor: 'rgba(45,212,191,0.25)', background: 'rgba(45,212,191,0.08)' }}
              >
                <Zap className="h-5 w-5" style={{ color: UAZAPI_COLOR }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  WhatsApp via UAZAPI
                </h3>
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  Instância própria · sem janela de 24h · ideal para o número de cada operador
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: 'rgba(45,212,191,0.1)', color: UAZAPI_COLOR }}
              >
                <Zap className="h-3 w-3" />
                {loading ? '—' : `${uazapiChannels.filter((c) => c.is_active).length} de ${uazapiChannels.length}`} instâncias ativas
              </span>
              <button
                onClick={() => setShowUazapiForm((v) => !v)}
                className="inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold transition"
                style={{
                  borderColor: 'rgba(45,212,191,0.35)',
                  background: 'rgba(45,212,191,0.08)',
                  color: UAZAPI_COLOR,
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Adicionar instância
              </button>
            </div>
          </div>

          {/* Form de nova instância UAZAPI */}
          {showUazapiForm ? (
            <div className="space-y-3 rounded-xl border border-[rgba(59,130,246,0.15)] bg-white/[0.02] p-4">
              <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Nova instância UAZAPI
              </h4>
            <input
              value={uazForm.label}
              onChange={(e) => setUazForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Nome do número (ex: WhatsApp da Maria)"
              className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
            />
            <input
              value={uazForm.serverUrl}
              onChange={(e) => setUazForm((f) => ({ ...f, serverUrl: e.target.value }))}
              placeholder="Server URL (https://…uazapi.com)"
              className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
            />
            <input
              value={uazForm.token}
              onChange={(e) => setUazForm((f) => ({ ...f, token: e.target.value }))}
              placeholder="Instance Token"
              type="password"
              className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
            />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowUazapiForm(false)}
                  className="rounded-lg border border-[rgba(59,130,246,0.2)] px-4 py-2 text-sm text-[var(--color-text-secondary)]"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => void saveUazapiChannel()}
                  disabled={savingUaz || !uazForm.serverUrl.trim() || !uazForm.token.trim()}
                  className="rounded-lg bg-gradient-to-br from-[#1E3A8A] to-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {savingUaz ? 'Conectando...' : 'Conectar e cadastrar webhook'}
                </button>
              </div>
            </div>
          ) : null}

          {/* Instâncias conectadas */}
          {loading ? (
            <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando números...
            </div>
          ) : uazapiChannels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-4 text-sm text-[var(--color-text-secondary)]">
              Nenhuma instância UAZAPI conectada. Cada operador pode conectar o próprio número
              clicando em "Adicionar instância".
            </div>
          ) : (
            <div className="space-y-3">{uazapiChannels.map(renderChannelCard)}</div>
          )}
        </div>
      </section>

    </div>
  );
}
