import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../src/lib/admin-auth.js';
import { getCredential, setCredential } from '../src/lib/credentials.js';
import {
  ZernioError,
  getNumberInfo,
  listAllAccounts,
  registerWebhook,
  resolveProfileId,
  type ZernioAccount,
  type ZernioNumberInfo,
} from '../src/lib/zernio.js';

// ============================================================================
// api/zernio-connect
// ----------------------------------------------------------------------------
// Roda DEPOIS que a Zernio API Key foi salva (api/credentials) — a chave agora
// vive no cofre POR ORG (public.org_settings). Resolve a(s) conta(s) WhatsApp
// conectadas, registra o webhook (URL com ?org=<uuid> para o roteamento
// multi-org) e materializa cada conta escolhida como um CANAL da org em
// whatsapp_hub.channels (multi-número). A chave nunca volta ao browser.
//
//  POST  → resolve + registra webhook + upsert do canal. Se houver mais de uma
//          conta WhatsApp e nenhuma escolhida, responde { needsSelection,
//          accounts } para a UI exibir o seletor e reenviar com { accountId }.
//  GET   → status cacheado (número + tier) + canais zernio da org.
// ============================================================================

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function authHeaderOf(req: ApiRequest): string | string[] | undefined {
  return req.headers?.authorization ?? req.headers?.Authorization;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function webhookUrl(orgId: string): string {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL ausente para montar a URL do webhook.');
  return `${base.replace(/\/$/, '')}/functions/v1/zernio-webhook?org=${encodeURIComponent(orgId)}`;
}

async function ensureWebhookSecret(orgId: string): Promise<string> {
  const existing = await getCredential(orgId, 'zernio_webhook_secret');
  if (existing && existing.trim()) return existing.trim();
  const secret = randomBytes(32).toString('hex');
  await setCredential(orgId, 'zernio_webhook_secret', secret);
  return secret;
}

// Materializa a conta como canal da org (idempotente pelo UNIQUE
// (org_id, provider, zernio_account_id)).
async function upsertZernioChannel(
  orgId: string,
  account: ZernioAccount,
  info: ZernioNumberInfo | null,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: selErr } = await supabase
    .schema('whatsapp_hub')
    .from('channels')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'zernio')
    .eq('zernio_account_id', account.id)
    .maybeSingle();
  if (selErr) throw selErr;

  const payload = {
    label: account.name ?? info?.verified_name ?? 'Conta Zernio',
    phone: info?.display_phone_number ?? null,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .update(payload)
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('channels')
      .insert({
        org_id: orgId,
        provider: 'zernio',
        zernio_account_id: account.id,
        ...payload,
      });
    if (error) throw error;
  }
}

function statusPayload(account: ZernioAccount | null, info: ZernioNumberInfo | null) {
  return {
    accountId: account?.id ?? null,
    accountName: account?.name ?? null,
    number: info
      ? {
          display_phone_number: info.display_phone_number,
          verified_name: info.verified_name,
          messaging_limit_tier: info.messaging_limit_tier,
          quality_rating: info.quality_rating,
          health_status: info.health_status,
        }
      : null,
  };
}

async function handleGet(orgId: string, res: ApiResponse) {
  const accountId = (await getCredential(orgId, 'zernio_account_id'))?.trim() || null;
  const rawInfo = await getCredential(orgId, 'zernio_number_info');
  let info: ZernioNumberInfo | null = null;
  if (rawInfo) {
    try {
      info = JSON.parse(rawInfo) as ZernioNumberInfo;
    } catch {
      info = null;
    }
  }

  const supabase = getSupabaseAdmin();
  const { data: channels } = await supabase
    .schema('whatsapp_hub')
    .from('channels')
    .select('id, label, phone, zernio_account_id, assigned_member, is_active')
    .eq('org_id', orgId)
    .eq('provider', 'zernio')
    .order('created_at');

  // Resolve a plataforma (whatsapp | instagram) de cada canal ao vivo pela API
  // do Zernio — evita uma coluna no banco e mantém o rótulo/ícone corretos.
  const platformById: Record<string, string> = {};
  const apiKey = (await getCredential(orgId, 'zernio_api_key'))?.trim();
  if (apiKey && (channels ?? []).length > 0) {
    try {
      for (const acc of await listAllAccounts(apiKey)) {
        if (acc.id) platformById[acc.id] = acc.platform;
      }
    } catch {
      // best-effort: sem a plataforma o card cai no fallback de número.
    }
  }
  const enrichedChannels = (channels ?? []).map((ch) => ({
    ...ch,
    platform: ch.zernio_account_id ? (platformById[ch.zernio_account_id] ?? null) : null,
  }));

  return res.status(200).json({
    success: true,
    connected: Boolean(accountId) || (channels ?? []).length > 0,
    accountId,
    channels: enrichedChannels,
    number: info
      ? {
          display_phone_number: info.display_phone_number,
          verified_name: info.verified_name,
          messaging_limit_tier: info.messaging_limit_tier,
          quality_rating: info.quality_rating,
          health_status: info.health_status,
        }
      : null,
  });
}

async function handlePost(orgId: string, req: ApiRequest, res: ApiResponse) {
  const apiKey = (await getCredential(orgId, 'zernio_api_key'))?.trim();
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      message: 'Salve a Zernio API Key antes de conectar.',
    });
  }

  const body = (req.body ?? {}) as { accountId?: unknown };
  const chosenId = typeof body.accountId === 'string' ? body.accountId.trim() : '';

  const accounts = await listAllAccounts(apiKey);
  if (accounts.length === 0) {
    return res.status(400).json({
      success: false,
      message:
        'Nenhuma conta encontrada no Zernio. Conecte o WhatsApp ou Instagram no painel do Zernio antes de continuar.',
    });
  }

  let account: ZernioAccount | undefined;
  if (chosenId) {
    account = accounts.find((item) => item.id === chosenId);
    if (!account) {
      return res
        .status(400)
        .json({ success: false, message: 'Conta selecionada nao encontrada.' });
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    return res.status(200).json({
      success: false,
      needsSelection: true,
      accounts: accounts.map((item) => ({ id: item.id, name: item.name, platform: item.platform })),
    });
  }

  // resolveProfileId e getNumberInfo são específicos para WhatsApp.
  const isWhatsapp = account.platform === 'whatsapp';
  const profileId = isWhatsapp ? await resolveProfileId(apiKey, account) : null;
  const numberInfo = isWhatsapp ? await getNumberInfo(apiKey, account.id) : null;

  // Default legado da org (fallback de envio) + cache de saúde do número.
  await setCredential(orgId, 'zernio_account_id', account.id);
  if (profileId) await setCredential(orgId, 'zernio_profile_id', profileId);
  await setCredential(orgId, 'zernio_number_info', JSON.stringify(numberInfo));

  // Multi-número: cada conta conectada vira um canal da org.
  await upsertZernioChannel(orgId, account, numberInfo);

  // Webhook: gera/reusa o segredo DA ORG e registra no Zernio com ?org= na URL
  // (roteamento multi-org). Best-effort — se o registro falhar, o setup nao
  // trava: o segredo fica salvo e devolvemos um aviso para retentar.
  const secret = await ensureWebhookSecret(orgId);
  let webhookWarning: string | null = null;
  try {
    await registerWebhook(apiKey, {
      url: webhookUrl(orgId),
      secret,
    });
  } catch (err) {
    webhookWarning =
      err instanceof Error ? err.message : 'Falha ao registrar o webhook no Zernio.';
    console.error(JSON.stringify({ event: 'zernio_webhook_register_failed', message: webhookWarning }));
  }

  return res.status(200).json({
    success: true,
    ...statusPayload(account, numberInfo),
    profileId,
    webhookWarning,
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

    const auth = await requireAdmin(authHeaderOf(req));
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    // `await` é essencial: sem ele, uma rejeição de handlePost/handleGet escapa
    // do try/catch como unhandled rejection → a Vercel devolve
    // FUNCTION_INVOCATION_FAILED em vez do JSON de erro tratado.
    return await (req.method === 'GET'
      ? handleGet(auth.orgId, res)
      : handlePost(auth.orgId, req, res));
  } catch (err) {
    if (err instanceof ZernioError) {
      return res.status(err.status === 401 ? 401 : 502).json({
        success: false,
        message: err.message,
      });
    }
    console.error('zernio-connect error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
