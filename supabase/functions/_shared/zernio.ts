// ============================================================================
// _shared/zernio.ts — client Zernio para as Edge Functions (Deno)
// ----------------------------------------------------------------------------
// Toda a comunicacao com o WhatsApp passa pelo Zernio. A ZERNIO_API_KEY e o
// accountId/profileId vivem cifrados em public.app_settings e sao lidos via
// getCredential — nunca de env var de aplicacao. Este modulo centraliza base
// URL, auth (Bearer) e tratamento de erro.
//
// ATENCAO: os formatos de payload de varios endpoints do Zernio (corpo do send
// message, shape de broadcasts/recipients) ainda nao foram validados contra a
// API real — pontos marcados com "ASSUMIDO" precisam de confirmacao no primeiro
// teste de integracao (ver "PONTOS A CONFIRMAR" #2 da refatoracao).
// ============================================================================

import { getCredentials } from './credentials.ts';

export const ZERNIO_API_BASE_URL =
  Deno.env.get('ZERNIO_API_BASE_URL') ?? 'https://zernio.com/api/v1';

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

export interface ZernioContext {
  apiKey: string;
  accountId: string;
  profileId: string | null;
}

// Carrega as credenciais do Zernio do cofre DA ORG. Lanca se a chave ou a
// conta nao estiverem configuradas (setup incompleto). O accountId aqui e o
// default legado da org — envio novo deve preferir o accountId do CANAL
// (whatsapp_hub.channels) da conversa/campanha.
export async function loadZernioContext(orgId: string): Promise<ZernioContext> {
  const creds = await getCredentials(orgId, [
    'zernio_api_key',
    'zernio_account_id',
    'zernio_profile_id',
  ]);
  const apiKey = creds.zernio_api_key?.trim();
  const accountId = creds.zernio_account_id?.trim();
  if (!apiKey) {
    throw new ZernioError('Zernio API Key nao configurada. Acesse /settings/credentials.', 400);
  }
  if (!accountId) {
    throw new ZernioError('Conta Zernio nao resolvida. Reabra /settings/credentials e salve a chave.', 400);
  }
  return { apiKey, accountId, profileId: creds.zernio_profile_id?.trim() || null };
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
    const msg =
      (body && typeof body === 'object'
        ? ((body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message)
        : typeof body === 'string'
          ? body
          : null);
    // 429 e 5xx sao transitorios — o chamador decide se re-tenta.
    const retryStatus = res.status === 429 || res.status >= 500 ? res.status : 502;
    throw new ZernioError(
      typeof msg === 'string' ? msg : `Zernio respondeu ${res.status} ${res.statusText}`,
      res.status === 401 || res.status === 403 ? 401 : retryStatus,
    );
  }
  return body;
}

function pickString(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inbox (mensagens 1:1 — IA e operador)
// ---------------------------------------------------------------------------

export interface InboxSendResult {
  messageId: string | null;
}

// POST /inbox/conversations/{id}/messages — envia texto/midia numa conversa
// existente (dentro da janela de 24h, sem template). Corpo real:
// { accountId, message, attachmentUrl?, attachmentType?, voiceNote? }.
export async function sendInboxMessage(input: {
  apiKey: string;
  accountId: string;
  conversationId: string;
  text?: string;
  attachmentUrl?: string;
  attachmentType?: 'image' | 'video' | 'audio' | 'file';
  voiceNote?: boolean;
}): Promise<InboxSendResult> {
  const body: Record<string, unknown> = { accountId: input.accountId };
  if (input.attachmentUrl) {
    body.attachmentUrl = input.attachmentUrl;
    body.attachmentType = input.voiceNote ? 'audio' : (input.attachmentType ?? 'file');
    if (input.voiceNote) body.voiceNote = true;
    if (input.text) body.message = input.text;
  } else {
    body.message = input.text ?? '';
  }
  const res = await zfetch(
    input.apiKey,
    `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return { messageId: pickString(res, ['_id', 'id', 'messageId']) ?? pickStringFromData(res) };
}

// POST /inbox/conversations/{id}/messages com template — usado para reabrir a
// conversa fora da janela de 24h (Meta só aceita template fora da janela).
// Shape real (WhatsApp): template.elements = [{ name, language, components }].
export async function sendInboxTemplate(input: {
  apiKey: string;
  accountId: string;
  conversationId: string;
  name: string;
  language: string;
  components: unknown[];
}): Promise<InboxSendResult> {
  const res = await zfetch(
    input.apiKey,
    `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        accountId: input.accountId,
        template: { elements: [{ name: input.name, language: input.language, components: input.components }] },
      }),
    },
  );
  return { messageId: pickString(res, ['_id', 'id', 'messageId']) ?? pickStringFromData(res) };
}

function pickStringFromData(body: unknown): string | null {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return pickString((body as Record<string, unknown>).data, ['_id', 'id', 'messageId']);
  }
  return null;
}

// POST /inbox/conversations — cria (ou reusa) a conversa 1:1 a partir do
// telefone (participantId). Corpo real: { accountId, participantId, message }.
export async function createInboxConversation(input: {
  apiKey: string;
  accountId: string;
  participantId: string; // telefone E.164 / wa_id
  message?: string;
}): Promise<{ conversationId: string | null; messageId: string | null }> {
  const body: Record<string, unknown> = {
    accountId: input.accountId,
    participantId: input.participantId,
  };
  if (input.message) body.message = input.message;
  const res = await zfetch(input.apiKey, '/inbox/conversations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data =
    res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)
      ? (res as Record<string, unknown>).data
      : res;
  return {
    conversationId: pickString(data, ['conversationId', '_id', 'id']),
    messageId: pickString(data, ['messageId', 'lastMessageId']),
  };
}

export interface InboxConversationSummary {
  id: string;
  accountId: string | null;
  platform: string | null;
  participantId: string | null;
  participantName: string | null;
}

// GET /inbox/conversations — lista as conversas do inbox. O `id` retornado aqui
// é o ÚNICO id aceito por POST /inbox/conversations/{id}/messages (o id que
// chega no webhook inbound NÃO serve para enviar). `participantId` é a
// identidade do contato (IG-scoped id no Instagram; wa_id no WhatsApp).
// Doc: platform ∈ facebook|instagram|twitter|bluesky|reddit|telegram.
export async function listInboxConversations(input: {
  apiKey: string;
  accountId?: string;
  platform?: string;
  status?: 'active' | 'archived';
  limit?: number;
  cursor?: string;
}): Promise<{ conversations: InboxConversationSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (input.accountId) params.set('accountId', input.accountId);
  if (input.platform) params.set('platform', input.platform);
  if (input.status) params.set('status', input.status);
  params.set('limit', String(input.limit ?? 100));
  if (input.cursor) params.set('cursor', input.cursor);

  const res = await zfetch(input.apiKey, `/inbox/conversations?${params.toString()}`);
  const root = (res ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(res) ? (res as unknown[]) : [];
  const pagination =
    root.pagination && typeof root.pagination === 'object'
      ? (root.pagination as Record<string, unknown>)
      : {};

  const conversations = (list as Record<string, unknown>[])
    .map((c) => ({
      id: pickString(c, ['id', '_id', 'conversationId']) ?? '',
      accountId: pickString(c, ['accountId', 'account_id']),
      platform: pickString(c, ['platform']),
      participantId: pickString(c, ['participantId', 'participant_id']),
      participantName: pickString(c, ['participantName']),
    }))
    .filter((c) => c.id !== '');

  return {
    conversations,
    nextCursor: pickString(pagination, ['nextCursor', 'cursor']),
    hasMore: typeof pagination.hasMore === 'boolean' ? (pagination.hasMore as boolean) : false,
  };
}

// Encontra a conversa VÁLIDA PARA ENVIO casando o `participantId` (útil no
// Instagram, onde não há telefone para criar a conversa via
// createInboxConversation). Devolve o summary inteiro — inclusive o `accountId`
// da conversa, que pode diferir do accountId do WhatsApp (cada conta social
// conectada no Zernio tem seu próprio id). Pagina até MAX_PAGES.
export async function resolveInboxConversation(input: {
  apiKey: string;
  accountId?: string;
  platform?: string;
  participantId: string;
}): Promise<InboxConversationSummary | null> {
  const MAX_PAGES = 10;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { conversations, nextCursor, hasMore } = await listInboxConversations({
      apiKey: input.apiKey,
      accountId: input.accountId,
      platform: input.platform,
      limit: 100,
      cursor,
    });
    const match = conversations.find((c) => c.participantId === input.participantId);
    if (match) return match;
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return null;
}

// True quando o Zernio rejeitou o conversationId no endpoint de envio — sinal de
// que o id salvo está obsoleto e precisa ser re-resolvido pela lista.
export function isConversationNotFoundError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return msg.includes('conversation not found') || msg.includes('list conversations');
}

// ---------------------------------------------------------------------------
// Broadcasts (disparo em massa)
// ---------------------------------------------------------------------------

// variableMapping (doc Zernio, "Template Variables"): resolvido POR DESTINATARIO
// no momento do envio. { field: 'name' } vira o nome do contato Zernio;
// { field: 'custom', customValue } e o mesmo valor para todos. Quando usado, os
// parameters do body devem ser os proprios placeholders ({ type:'text',
// text:'{{1}}' }).
export type BroadcastVariableMapping = Record<
  string,
  { field: 'name' } | { field: 'custom'; customValue: string }
>;

export interface BroadcastTemplate {
  name: string;
  language: string;
  components: unknown[];
  variableMapping?: BroadcastVariableMapping;
}

// POST /broadcasts → cria o broadcast e devolve o id.
export async function createBroadcast(input: {
  apiKey: string;
  profileId: string;
  accountId: string;
  name: string;
  template: BroadcastTemplate;
}): Promise<string> {
  const res = await zfetch(input.apiKey, '/broadcasts', {
    method: 'POST',
    body: JSON.stringify({
      profileId: input.profileId,
      accountId: input.accountId,
      platform: 'whatsapp',
      name: input.name,
      template: input.template,
    }),
  });
  // Resposta real: { broadcast: { id, name, status } }.
  const root = (res ?? {}) as Record<string, unknown>;
  const data = (root.broadcast ?? root.data ?? root) as Record<string, unknown>;
  const id = pickString(data, ['id', '_id', 'broadcastId']);
  if (!id) throw new ZernioError('Zernio nao retornou o id do broadcast.');
  return id;
}

// POST /broadcasts/{id}/recipients — aceita phones[], contactIds[] ou useSegment.
export async function addBroadcastRecipients(input: {
  apiKey: string;
  broadcastId: string;
  phones?: string[];
  contactIds?: string[];
  useSegment?: boolean;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.useSegment) body.useSegment = true;
  else if (input.contactIds?.length) body.contactIds = input.contactIds;
  else if (input.phones?.length) body.phones = input.phones;
  await zfetch(input.apiKey, `/broadcasts/${encodeURIComponent(input.broadcastId)}/recipients`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// POST /contacts/bulk — importa ate 1000 contatos por chamada (doc: duplicados
// sao pulados, tags novas mescladas). Usado antes de broadcasts com variavel
// { field: 'name' }: garante que os contatos auto-criados pelo Zernio ja nascam
// com nome, senao o placeholder resolveria vazio. Contatos ja existentes no
// Zernio mantem o nome que la estiver (a doc nao promete update de nome).
export async function bulkCreateContacts(input: {
  apiKey: string;
  profileId: string;
  accountId: string;
  contacts: Array<{ name: string; platformIdentifier: string }>;
}): Promise<void> {
  if (input.contacts.length === 0) return;
  await zfetch(input.apiKey, '/contacts/bulk', {
    method: 'POST',
    body: JSON.stringify({
      profileId: input.profileId,
      accountId: input.accountId,
      platform: 'whatsapp',
      contacts: input.contacts,
    }),
  });
}

// POST /broadcasts/{id}/schedule — agenda envio futuro.
export async function scheduleBroadcast(input: {
  apiKey: string;
  broadcastId: string;
  scheduledAt: string;
}): Promise<void> {
  await zfetch(input.apiKey, `/broadcasts/${encodeURIComponent(input.broadcastId)}/schedule`, {
    method: 'POST',
    body: JSON.stringify({ scheduledAt: input.scheduledAt }),
  });
}

// POST /broadcasts/{id}/send — envio imediato.
export async function sendBroadcast(input: {
  apiKey: string;
  broadcastId: string;
}): Promise<void> {
  await zfetch(input.apiKey, `/broadcasts/${encodeURIComponent(input.broadcastId)}/send`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface BroadcastRecipient {
  phone: string | null;        // E.164/wa_id do destinatario (chave de correlacao)
  status: string | null;       // status cru do Zernio (sent/delivered/read/failed/...)
  error: string | null;        // motivo, quando failed
  messageId: string | null;    // zernio/meta message id, quando disponivel
}

// GET /broadcasts/{id}/recipients — status de entrega por destinatario. O evento
// de webhook do Zernio NAO carrega o broadcastId, entao este endpoint eh a unica
// forma de reconciliar delivered/read/failed de campanha (consumido pelo job de
// polling sync-broadcast-status).
// Shape real confirmado contra a API:
//   { success, recipients: [{ platformIdentifier, status, messageId,
//     error?/errorExplanation, sentAt, deliveredAt, ... }], pagination:
//     { total, limit, skip, hasMore } }
// O telefone vem em `platformIdentifier` (digits-only, sem '+') e a resposta e
// paginada (default ~50/pagina) — precisamos seguir `pagination.hasMore` via
// `skip`, senao so os primeiros N destinatarios sao reconciliados.
export async function getBroadcastRecipients(
  apiKey: string,
  broadcastId: string,
): Promise<BroadcastRecipient[]> {
  const out: BroadcastRecipient[] = [];
  const limit = 100;
  let skip = 0;

  // Guard contra loop infinito caso a API ignore `skip` mas devolva hasMore=true.
  for (let page = 0; page < 200; page += 1) {
    const res = await zfetch(
      apiKey,
      `/broadcasts/${encodeURIComponent(broadcastId)}/recipients?limit=${limit}&skip=${skip}`,
    );
    const root = (res ?? {}) as Record<string, unknown>;
    const list = Array.isArray(root.recipients)
      ? root.recipients
      : Array.isArray(root.data)
        ? root.data
        : Array.isArray(res)
          ? (res as unknown[])
          : [];

    for (const r of list as Record<string, unknown>[]) {
      out.push({
        phone: pickString(r, [
          'platformIdentifier',
          'contactIdentifier',
          'phone',
          'phoneNumber',
          'to',
          'wa_id',
          'recipient',
          'msisdn',
        ]),
        status: pickString(r, ['status', 'state', 'deliveryStatus']),
        error: pickString(r, [
          'error',
          'errorExplanation',
          'errorMessage',
          'error_message',
          'reason',
        ]),
        messageId: pickString(r, ['messageId', 'message_id', 'zernioMessageId', 'wamid']),
      });
    }

    const pagination = root.pagination && typeof root.pagination === 'object'
      ? (root.pagination as Record<string, unknown>)
      : null;
    const hasMore = pagination ? Boolean(pagination.hasMore) : false;
    if (!hasMore || list.length === 0) break;
    skip += list.length;
  }

  return out;
}

// ---------------------------------------------------------------------------
// WhatsApp number / templates
// ---------------------------------------------------------------------------

export interface ZernioNumberInfo {
  messaging_limit_tier: string | null;
  quality_rating: string | null;
  health_status: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
}

// Resposta real aninhada: { phone: { display_phone_number, verified_name,
// quality_rating, messaging_limit_tier, status, health_status }, waba: {...} }.
export async function getNumberInfo(apiKey: string, accountId: string): Promise<ZernioNumberInfo> {
  const res = await zfetch(
    apiKey,
    `/whatsapp/number-info?accountId=${encodeURIComponent(accountId)}`,
  );
  const root = ((res as Record<string, unknown>) ?? {});
  const phone = (root.phone && typeof root.phone === 'object'
    ? root.phone
    : root) as Record<string, unknown>;
  return {
    messaging_limit_tier: pickString(phone, ['messaging_limit_tier', 'messagingLimitTier']),
    quality_rating: pickString(phone, ['quality_rating', 'qualityRating']),
    health_status: pickString(phone, ['status', 'connection_status']),
    display_phone_number: pickString(phone, ['display_phone_number', 'displayPhoneNumber']),
    verified_name: pickString(phone, ['verified_name', 'verifiedName', 'name']),
  };
}

// POST /media/upload-direct — sobe o binário (máx 25MB, auto-delete em 7 dias)
// e devolve a `url` para usar no attachmentUrl do send message. NÃO usa zfetch
// porque o corpo é binário (Content-Type = mime do arquivo), não JSON.
// ASSUMIDO: binário cru no body + filename via query. Confirmar na doc real.
export async function uploadMediaDirect(input: {
  apiKey: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}): Promise<string> {
  const MAX_BYTES = 25 * 1024 * 1024;
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new ZernioError('Arquivo excede o limite de 25MB do Zernio.', 400);
  }
  let res: Response;
  try {
    res = await fetch(
      `${ZERNIO_API_BASE_URL}/media/upload-direct?filename=${encodeURIComponent(input.filename)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': input.contentType,
        },
        body: input.bytes,
      },
    );
  } catch (err) {
    throw new ZernioError(
      `Falha de rede ao subir mídia: ${err instanceof Error ? err.message : 'erro'}`,
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
    const msg =
      body && typeof body === 'object'
        ? pickString(body as Record<string, unknown>, ['error', 'message'])
        : null;
    throw new ZernioError(msg ?? `Zernio upload-direct respondeu ${res.status}`);
  }
  const data =
    body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).data
      : body;
  const url = pickString((data ?? {}) as Record<string, unknown>, ['url', 'link', 'href']);
  if (!url) throw new ZernioError('Zernio upload-direct não retornou url.');
  return url;
}

export type ZernioTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

// POST /whatsapp/templates — submete template para aprovacao na Meta via Zernio.
export async function createTemplate(input: {
  apiKey: string;
  accountId: string;
  name: string;
  category: ZernioTemplateCategory;
  language: string;
  components: unknown[];
}): Promise<{ id: string | null; status: string | null }> {
  const res = await zfetch(input.apiKey, '/whatsapp/templates', {
    method: 'POST',
    body: JSON.stringify({
      accountId: input.accountId,
      name: input.name,
      category: input.category,
      language: input.language,
      components: input.components,
    }),
  });
  // Resposta real: { success, template: { id, name, status, category, language } }.
  const root = (res ?? {}) as Record<string, unknown>;
  const data = (root.template ?? root.data ?? root) as Record<string, unknown>;
  return {
    id: pickString(data, ['id', '_id', 'templateId']),
    status: pickString(data, ['status', 'meta_status']),
  };
}

// ---------------------------------------------------------------------------
// Meta Ads (insights de contas de anúncios)
// ----------------------------------------------------------------------------
// O Zernio relaya a Graph API de insights da Meta. Fluxo:
//   1. GET /accounts            → descobre a SocialAccount de plataforma metaads
//                                 (o accountId dos endpoints de ads é o id dessa
//                                 conta social, diferente do zernio_account_id
//                                 do WhatsApp).
//   2. GET /ads/accounts        → lista as contas de anúncios (act_<n> + nome)
//                                 sob aquela conta social. Casamos pelo nome
//                                 ("CA 01 Agentise" / "CA 02 Agentise").
//   3. GET /ads/insights        → gasto (spend) por conta no intervalo pedido.
// Vários shapes de resposta ainda não foram confirmados contra a API real
// (marcados "ASSUMIDO"); por isso o parsing é defensivo e o chamador degrada
// para "indisponível" em caso de erro em vez de quebrar o dashboard.
// ---------------------------------------------------------------------------

export interface ZernioSocialAccount {
  id: string;
  platform: string | null;
  name: string | null;
}

function pickNumber(body: unknown, keys: string[]): number | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

// GET /accounts → lista as contas sociais conectadas no Zernio (WhatsApp,
// metaads, facebook, instagram, ...). Usada para descobrir a conta de ads.
export async function listSocialAccounts(apiKey: string): Promise<ZernioSocialAccount[]> {
  const res = await zfetch(apiKey, '/accounts');
  const root = (res ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.accounts)
      ? root.accounts
      : Array.isArray(res)
        ? (res as unknown[])
        : [];
  return (list as Record<string, unknown>[])
    .map((a) => ({
      id: pickString(a, ['id', '_id', 'accountId']) ?? '',
      platform: pickString(a, ['platform', 'type', 'provider']),
      name: pickString(a, ['name', 'displayName', 'username']),
    }))
    .filter((a) => a.id !== '');
}

// Descobre o id da conta social que dá acesso aos insights de Meta Ads. A doc do
// Zernio diz que o endpoint de ads é "sibling-expanded": passar o id metaads,
// facebook OU instagram cobre os anúncios ligados. Preferimos metaads.
export async function resolveMetaAdsAccountId(apiKey: string): Promise<string | null> {
  const accounts = await listSocialAccounts(apiKey);
  const byPlatform = (p: string) =>
    accounts.find((a) => (a.platform ?? '').toLowerCase() === p)?.id ?? null;
  return (
    byPlatform('metaads') ??
    byPlatform('meta_ads') ??
    byPlatform('facebook') ??
    byPlatform('instagram') ??
    null
  );
}

export interface ZernioAdAccount {
  id: string; // act_<n>
  name: string | null;
  currency: string | null;
}

// GET /ads/accounts?accountId= → contas de anúncios (act_<n>) da conta social.
export async function listAdAccounts(
  apiKey: string,
  accountId: string,
): Promise<ZernioAdAccount[]> {
  const res = await zfetch(
    apiKey,
    `/ads/accounts?accountId=${encodeURIComponent(accountId)}`,
  );
  const root = (res ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.accounts)
      ? root.accounts
      : Array.isArray(res)
        ? (res as unknown[])
        : [];
  return (list as Record<string, unknown>[])
    .map((a) => ({
      id: pickString(a, ['id', 'accountId', 'act', 'ad_account_id']) ?? '',
      name: pickString(a, ['name', 'accountName', 'displayName']),
      currency: pickString(a, ['currency', 'accountCurrency']),
    }))
    .filter((a) => a.id !== '');
}

// GET /ads/insights?accountId=&objectId=act_<n>&level=account&fromDate=&toDate=
//   &fields=spend → gasto da conta de anúncios no intervalo (YYYY-MM-DD).
// Resposta (Meta, verbatim): { objectId, data: [{ spend: "2116.23",
//   date_start, date_stop }], paging }. O `spend` vem como STRING em unidades
// nativas da moeda da conta; somamos as linhas de data[] (normalmente 1).
export async function getAdAccountSpend(input: {
  apiKey: string;
  accountId: string; // conta social (metaads)
  objectId: string; // act_<n>
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
}): Promise<number> {
  const params = new URLSearchParams({
    accountId: input.accountId,
    objectId: input.objectId,
    level: 'account',
    fromDate: input.fromDate,
    toDate: input.toDate,
    fields: 'spend',
  });
  const res = await zfetch(input.apiKey, `/ads/insights?${params.toString()}`);
  const root = (res ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(root.data) ? (root.data as Record<string, unknown>[]) : [];
  let sum = 0;
  for (const row of rows) {
    const spend = pickNumber(row, ['spend']);
    if (spend !== null) sum += spend;
  }
  return sum;
}

// GET /whatsapp/templates?accountId= → lista os templates da WABA direto da Meta.
// Usado para sincronizar o status localmente (fallback ao webhook).
export async function listTemplates(
  apiKey: string,
  accountId: string,
): Promise<Array<{ id: string | null; name: string | null; status: string | null }>> {
  const res = await zfetch(
    apiKey,
    `/whatsapp/templates?accountId=${encodeURIComponent(accountId)}`,
  );
  const root = (res ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.templates)
    ? root.templates
    : Array.isArray(root.data)
      ? root.data
      : [];
  return (list as Record<string, unknown>[]).map((t) => ({
    id: pickString(t, ['id', '_id', 'templateId']),
    name: pickString(t, ['name', 'templateName']),
    status: pickString(t, ['status', 'meta_status']),
  }));
}
