// Cliente HTTP do Zernio para o lado Node (Vercel API Routes), usado no setup
// para resolver a conta WhatsApp conectada e registrar o webhook. A
// ZERNIO_API_KEY nunca trafega pelo browser: o valor chega uma vez via HTTPS,
// fica cifrado em public.app_settings e todas as chamadas ao Zernio saem daqui.
//
// As Edge Functions de runtime (Module 2) terao seu proprio client Deno; este
// arquivo cobre apenas o fluxo de setup/configuracao.
//
// Os formatos de resposta do Zernio sao tolerados de forma defensiva (array ou
// { data: [...] }, camelCase ou snake_case) porque ainda nao foram validados
// contra um payload real — ver "PONTOS A CONFIRMAR" #2 da refatoracao.

// Base da API Zernio. Definida localmente (sem importar setup.config) para que
// o bundle Node das API Routes não puxe esse módulo — um import extensionless
// na cadeia quebrava a resolução no build da Vercel (FUNCTION_INVOCATION_FAILED).
const ZERNIO_API_BASE_URL = process.env.ZERNIO_API_BASE_URL || 'https://zernio.com/api/v1';

export const ZERNIO_WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'whatsapp.template.status_updated',
  'whatsapp.number.activated',
  'whatsapp.number.declined',
  'whatsapp.number.action_required',
  'whatsapp.number.verification_required',
  'whatsapp.number.suspended',
  'whatsapp.number.reactivated',
  'whatsapp.number.released',
  'account.disconnected',
] as const;

export class ZernioError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ZernioError';
    this.status = status;
  }
}

type Json = Record<string, unknown>;

function pickString(obj: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function asList(body: unknown): Json[] {
  if (Array.isArray(body)) return body as Json[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'accounts', 'profiles', 'items', 'results']) {
      const value = (body as Json)[key];
      if (Array.isArray(value)) return value as Json[];
    }
  }
  return [];
}

async function zfetch(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${ZERNIO_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ZernioError(
      `Falha de rede ao falar com o Zernio: ${err instanceof Error ? err.message : 'erro'}`,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const fromBody =
      body && typeof body === 'object'
        ? pickString(body as Json, ['error', 'message'])
        : typeof body === 'string'
          ? body
          : null;
    throw new ZernioError(
      fromBody ?? `Zernio respondeu ${res.status} ${res.statusText}`,
      res.status === 401 || res.status === 403 ? 401 : 502,
    );
  }
  return body;
}

export interface ZernioAccount {
  id: string;
  platform: string;
  name: string;
  profileId: string | null;
}

function parseAccount(raw: Json, defaultName: string): ZernioAccount {
  // Em GET /accounts o profileId vem como objeto { _id, name, slug }.
  // Toleramos também string (caso a API mude) ou camelCase alternativo.
  const profileRaw = raw.profileId ?? raw.profile;
  const profileId =
    typeof profileRaw === 'string' && profileRaw.trim()
      ? profileRaw
      : profileRaw && typeof profileRaw === 'object'
        ? pickString(profileRaw as Json, ['_id', 'id'])
        : null;
  return {
    id: pickString(raw, ['_id', 'id']) ?? '',
    platform: (pickString(raw, ['platform', 'channel']) ?? '').toLowerCase(),
    name: pickString(raw, ['displayName', 'username', 'name', 'label']) ?? defaultName,
    profileId,
  };
}

// GET /accounts → todas as contas conectadas (whatsapp, instagram, etc.).
export async function listAllAccounts(apiKey: string): Promise<ZernioAccount[]> {
  const body = await zfetch(apiKey, '/accounts');
  return asList(body)
    .map((raw) => parseAccount(raw, 'Conta conectada'))
    .filter((account) => account.id);
}

// GET /accounts → apenas contas WhatsApp (platform: 'whatsapp').
export async function listWhatsappAccounts(apiKey: string): Promise<ZernioAccount[]> {
  const accounts = await listAllAccounts(apiKey);
  return accounts.filter((account) => account.platform === 'whatsapp');
}

// GET /profiles → resolve o profileId que agrupa a conta (obrigatorio nos
// broadcasts). Se a propria conta ja carrega o profileId, usa esse.
export async function resolveProfileId(
  apiKey: string,
  account: ZernioAccount,
): Promise<string | null> {
  if (account.profileId) return account.profileId;
  const body = await zfetch(apiKey, '/profiles');
  const profiles = asList(body);
  const match = profiles.find((profile) => {
    const ids = profile.accountIds ?? profile.accounts;
    return Array.isArray(ids) && ids.map(String).includes(account.id);
  });
  const chosen = match ?? profiles[0];
  return chosen ? pickString(chosen, ['_id', 'id']) : null;
}

export interface ZernioNumberInfo {
  messaging_limit_tier: string | null;
  quality_rating: string | null;
  health_status: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
}

// GET /whatsapp/number-info?accountId= → status do numero conectado. A resposta
// real vem aninhada: { phone: { display_phone_number, verified_name,
// quality_rating, messaging_limit_tier, status, health_status }, waba: {...} }.
export async function getNumberInfo(
  apiKey: string,
  accountId: string,
): Promise<ZernioNumberInfo> {
  const body = await zfetch(
    apiKey,
    `/whatsapp/number-info?accountId=${encodeURIComponent(accountId)}`,
  );
  const root = (body ?? {}) as Json;
  const phone = (root.phone && typeof root.phone === 'object' ? root.phone : root) as Json;
  // health_status é objeto na API; usamos o `status` do número (ex.: CONNECTED)
  // como rótulo simples de saúde para o widget.
  return {
    messaging_limit_tier: pickString(phone, ['messaging_limit_tier', 'messagingLimitTier']),
    quality_rating: pickString(phone, ['quality_rating', 'qualityRating']),
    health_status: pickString(phone, ['status', 'connection_status']),
    display_phone_number: pickString(phone, ['display_phone_number', 'displayPhoneNumber']),
    verified_name: pickString(phone, ['verified_name', 'verifiedName', 'name']),
  };
}

// Registra o webhook do Zernio (POST /webhooks/settings). É por-usuário (não por
// conta): name, url e events são obrigatórios; secret habilita o HMAC. Máx 10
// webhooks por usuário; reusa-se o mesmo apontando para o zernio-webhook.
export async function registerWebhook(
  apiKey: string,
  opts: { url: string; secret: string; events?: readonly string[] },
): Promise<void> {
  await zfetch(apiKey, '/webhooks/settings', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Mega CRM',
      url: opts.url,
      secret: opts.secret,
      events: opts.events ?? ZERNIO_WEBHOOK_EVENTS,
      isActive: true,
    }),
  });
}
