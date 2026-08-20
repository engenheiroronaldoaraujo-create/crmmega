// ============================================================================
// zernio-webhook  (public, HMAC-verified)
// ----------------------------------------------------------------------------
// Receiver unico dos eventos do Zernio (substitui o antigo meta-webhook). Nao
// ha mais handshake/verify-token da Meta — o Zernio assina cada POST com
// HMAC-SHA256 no header X-Zernio-Signature (segredo: zernio_webhook_secret).
//
// Fluxo:
//   1. Valida X-Zernio-Signature (constant-time) contra o segredo do cofre.
//   2. Idempotencia: deduplica pelo event id estavel via whatsapp_hub.webhook_events.
//   3. Trata os eventos:
//        message.received                  → upsert conversa + mensagem (dispara IA via trigger)
//        message.sent/delivered/read/failed → status de campanha (broadcast) ou de mensagem 1:1
//        whatsapp.template.status_updated  → status do template (substitui o polling)
//        whatsapp.number.*                 → atualiza cache de saude do numero
//        account.disconnected              → log/alerta
//
// Deploy com --no-verify-jwt: o Zernio chama anonimamente; o HMAC e o unico gate.
//
// Os shapes seguem o OpenAPI do Zernio (WebhookPayloadMessage /
// WebhookPayloadMessageDeliveryStatus / WebhookPayloadWhatsAppTemplateStatusUpdated).
// A normalizacao abaixo continua tolerante a variacoes menores de campo.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getCredential, setCredential } from '../_shared/credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getNumberInfo, loadZernioContext } from '../_shared/zernio.ts';
import { getChannelByZernioAccount, type ChannelRow } from '../_shared/channels.ts';
import { maybeAddLeadToFunnel } from '../_shared/funnel.ts';

type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

// --- HMAC ------------------------------------------------------------------

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Raw(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return new Uint8Array(mac);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// O formato do X-Zernio-Signature (hex vs base64) não está explícito na doc;
// aceitamos ambos, com prefixo opcional "sha256=", comparação constant-time.
function signatureMatches(header: string, mac: Uint8Array): boolean {
  const got = (header.startsWith('sha256=') ? header.slice(7) : header).trim();
  return timingSafeEqualStr(got, bytesToHex(mac)) || timingSafeEqualStr(got, bytesToBase64(mac));
}

// --- normalizacao do payload (conforme OpenAPI do Zernio) ------------------

interface ZernioEvent {
  id: string | null;
  type: string;
  data: Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function normalizeEvent(payload: unknown): ZernioEvent {
  const root = asObject(payload);
  const type = str(root, ['type', 'event', 'eventType']) ?? '';
  const id = str(root, ['id', 'eventId', '_id']);
  const data = root.data ? asObject(root.data) : root;
  return { id: id ?? null, type, data };
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

// --- helpers de dominio -----------------------------------------------------

async function findOrCreateContact(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  phone: string,
  name: string | null,
): Promise<string | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, phone, name, source: 'whatsapp' })
    .select('id')
    .single();
  if (error) return null;
  return (created as { id: string }).id;
}

// Instagram: o contato é identificado pelo IG-scoped id (não tem telefone).
// Dedup por instagram_id (por org); se não existir, cria com source='instagram'.
async function findOrCreateInstagramContact(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  igId: string,
  name: string | null,
): Promise<string | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id')
    .eq('org_id', orgId)
    .eq('instagram_id', igId)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, instagram_id: igId, name, source: 'instagram' })
    .select('id')
    .single();
  if (error) return null;
  return (created as { id: string }).id;
}

async function findOrCreateConversation(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  contactId: string,
  zernioConversationId: string | null,
  channel: 'whatsapp' | 'instagram' = 'whatsapp',
  zernioAccountId: string | null = null,
  channelRow: ChannelRow | null = null,
  leadTitle: string | null = null,
): Promise<string | null> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id, zernio_conversation_id, zernio_account_id, provider, channel_id')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) {
    const row = existing as {
      id: string;
      zernio_conversation_id: string | null;
      zernio_account_id: string | null;
      provider: string | null;
      channel_id: string | null;
    };
    // Preenche o zernio_conversation_id assim que o Zernio o revela (necessario
    // para o operador/IA responderem 1:1 via /inbox/conversations/{id}) e
    // carimba a conta que recebeu. O último inbound decide o provedor da
    // conversa — se ela estava como 'uazapi', volta a 'zernio'. Não sobrescreve
    // a atribuição de operador de conversas já existentes.
    const patch: Record<string, unknown> = {};
    if (zernioConversationId && !row.zernio_conversation_id) {
      patch.zernio_conversation_id = zernioConversationId;
    }
    if (zernioAccountId && row.zernio_account_id !== zernioAccountId) {
      patch.zernio_account_id = zernioAccountId;
    }
    if (channelRow && row.channel_id !== channelRow.id) patch.channel_id = channelRow.id;
    if (row.provider !== 'zernio') patch.provider = 'zernio';
    if (Object.keys(patch).length > 0) {
      await admin.from('conversations').update(patch).eq('id', row.id);
    }
    return row.id;
  }
  const insert: Record<string, unknown> = {
    org_id: orgId,
    contact_id: contactId,
    status: 'ai_active',
    channel,
    zernio_conversation_id: zernioConversationId,
    zernio_account_id: zernioAccountId,
    last_message_at: new Date().toISOString(),
  };
  if (channelRow) {
    insert.channel_id = channelRow.id;
    // Atribuição automática: conversa nova herda o operador do canal (se houver).
    if (channelRow.assigned_member) {
      insert.assigned_to = channelRow.assigned_member;
      insert.assigned_at = new Date().toISOString();
    }
  }
  const { data: created, error } = await admin
    .from('conversations')
    .insert(insert)
    .select('id')
    .single();
  if (error) return null;
  const conversationId = (created as { id: string }).id;
  // Lead novo entrando em contato: adiciona ao funil configurado do canal.
  await maybeAddLeadToFunnel(admin, orgId, contactId, channelRow, leadTitle, channel);
  // IA desligada neste número: a conversa nasce direto no humano. O UPDATE
  // (não o INSERT) faz o flip ai_paused false→true, que dispara os triggers
  // de handoff — notifica o operador vinculado ou cai no rodízio/fanout.
  if (channelRow && channelRow.ai_enabled === false) {
    await admin
      .from('conversations')
      .update({ status: 'human_active', ai_paused: true })
      .eq('id', conversationId);
  }
  return conversationId;
}

// InboxWebhookMessage: { text, attachments:[{type: image|video|audio|file|
// sticker|share, url}] }. O tipo vem do attachment; sem attachment é texto.
function decodeInbound(message: Record<string, unknown>): {
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document';
  content: string | null;
  mediaUrl: string | null;
} {
  const text = str(message, ['text', 'body', 'caption']);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const firstAttachment = asObject(attachments[0]);
  const mediaUrl = str(firstAttachment, ['url', 'link', 'href']);
  const attType = (str(firstAttachment, ['type']) ?? '').toLowerCase();

  if (!mediaUrl) return { contentType: 'text', content: text ?? '', mediaUrl: null };
  switch (attType) {
    case 'image':
    case 'sticker':
      return { contentType: 'image', content: text, mediaUrl };
    case 'audio':
    case 'voice':
      return { contentType: 'audio', content: null, mediaUrl };
    case 'video':
      return { contentType: 'video', content: text, mediaUrl };
    default: // file, share, document
      return { contentType: 'document', content: text, mediaUrl };
  }
}

// --- handlers de evento -----------------------------------------------------

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

async function handleMessageReceived(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  data: Record<string, unknown>,
  errors: string[],
  platform: 'whatsapp' | 'instagram' = 'whatsapp',
): Promise<void> {
  const message = asObject(data.message ?? data);
  const conversation = asObject(data.conversation);
  const sender = asObject(message.sender);
  const zernioConversationId = str(conversation, ['id']) ?? str(message, ['conversationId']);
  const zernioMessageId = str(message, ['id', '_id']);
  const contactName = str(sender, ['name']) ?? str(conversation, ['participantName']);

  // Resolução de identidade depende do canal. WhatsApp usa telefone (E.164);
  // Instagram usa o IG-scoped id/username (sem telefone).
  // ASSUMIDO: shape do payload Instagram do Zernio (sender.id/username,
  // conversation.participantId) — confirmar no 1º teste com conta real.
  let contactId: string | null;
  if (platform === 'instagram') {
    const igId =
      str(sender, ['id', 'username', 'igsid', 'instagramId']) ??
      str(conversation, ['participantId']);
    if (!igId) {
      errors.push('message.received (instagram) sem identidade');
      return;
    }
    contactId = await findOrCreateInstagramContact(admin, orgId, igId, contactName ?? igId);
    if (!contactId) {
      errors.push(`contato instagram falhou: ${igId}`);
      return;
    }
  } else {
    // WhatsApp: sender.phoneNumber é E.164 (+...). Fallbacks: sender.id (telefone
    // sem +) e conversation.participantId (wa_id).
    const phone =
      str(sender, ['phoneNumber']) ??
      normalizePhone(str(sender, ['id'])) ??
      normalizePhone(str(conversation, ['participantId']));
    if (!phone) {
      errors.push('message.received sem telefone');
      return;
    }
    contactId = await findOrCreateContact(admin, orgId, phone, contactName);
    if (!contactId) {
      errors.push(`contato falhou: ${phone}`);
      return;
    }
  }

  // Conta Zernio que recebeu a mensagem — distingue os numeros (Meta × UAZAPI).
  const account = asObject(data.account);
  const zernioAccountId =
    str(account, ['id', '_id', 'accountId']) ?? str(message, ['accountId', 'account_id']);

  // Resolve o CANAL da org pelo zernio_account_id. Pode ser null (número ainda
  // não cadastrado em channels) — segue sem channel_id. Mismatch de org é
  // descartado como configuração errada.
  let channelRow: ChannelRow | null = null;
  if (zernioAccountId) {
    channelRow = await getChannelByZernioAccount(admin, zernioAccountId);
    if (channelRow && channelRow.org_id !== orgId) {
      console.log(JSON.stringify({
        event: 'zernio_channel_org_mismatch',
        zernio_account_id: zernioAccountId,
        channel_org: channelRow.org_id,
        event_org: orgId,
      }));
      channelRow = null;
    }
  }

  const conversationId = await findOrCreateConversation(
    admin,
    orgId,
    contactId,
    zernioConversationId,
    platform,
    zernioAccountId,
    channelRow,
    contactName,
  );
  if (!conversationId) {
    errors.push('conversa falhou');
    return;
  }

  // Dedup de mensagem (at-least-once). O indice unico parcial cobre a corrida.
  if (zernioMessageId) {
    const { data: dup } = await admin
      .from('messages')
      .select('id')
      .eq('org_id', orgId)
      .eq('zernio_message_id', zernioMessageId)
      .maybeSingle();
    if (dup) return;
  }

  const { contentType, content, mediaUrl } = decodeInbound(message);
  const { error: insErr } = await admin.from('messages').insert({
    org_id: orgId,
    conversation_id: conversationId,
    direction: 'inbound',
    sender_type: 'contact',
    content_type: contentType,
    content,
    media_url: mediaUrl,
    zernio_message_id: zernioMessageId,
    is_private_note: false,
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') return; // corrida de dedup
    errors.push(`message insert: ${insErr.message}`);
    return;
  }

  await admin.rpc('increment_unread_count', { p_conversation_id: conversationId });

  // Resposta do contato cancela follow-ups: marca o ultimo campaign_contact ativo.
  const { data: ccHit } = await admin
    .from('campaign_contacts')
    .select('id, campaign_id')
    .eq('contact_id', contactId)
    .is('replied_at', null)
    .in('status', ['sent', 'delivered', 'read'])
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ccHit) {
    await admin
      .from('campaign_contacts')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', (ccHit as { id: string }).id);
    await admin.rpc('bump_campaign_counter', {
      p_campaign_id: (ccHit as { campaign_id: string }).campaign_id,
      p_column: 'replied',
      p_delta: 1,
    });
  }
}

// WebhookPayloadMessageDeliveryStatus: { event, message: InboxWebhookMessage,
// statusAt, error?, conversation, account }. Refere-se a uma mensagem OUTGOING
// pelo message.id interno. O payload NÃO carrega broadcastId — a correlação por
// destinatário de broadcast usa GET /broadcasts/{id}/recipients (fora deste
// handler). Aqui atualizamos a mensagem 1:1 (IA/operador) na tabela messages.
async function handleStatus(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  status: DeliveryStatus,
  data: Record<string, unknown>,
): Promise<void> {
  const message = asObject(data.message);
  const zernioMessageId = str(message, ['id', '_id']) ?? str(message, ['platformMessageId']);
  if (!zernioMessageId) return;

  // Envios DIRETOS de campanha (variaveis de negocio, 1:1) tem
  // zernio_message_id na linha de campaign_contacts — o status deles chega por
  // aqui, nao pelo sync de broadcast. Avanca a linha + contadores agregados.
  await syncCampaignContactStatus(admin, orgId, status, zernioMessageId, data);

  const { data: msg } = await admin
    .from('messages')
    .select('id, meta_status')
    .eq('org_id', orgId)
    .eq('zernio_message_id', zernioMessageId)
    .maybeSingle();
  if (!msg) return;
  const m = msg as { id: string; meta_status: string | null };
  if (status === 'failed') {
    // Motivo da falha: `error` pode vir como string ou objeto ({ message, ... }).
    const rawError = data.error;
    const reason =
      typeof rawError === 'string' && rawError.trim() !== ''
        ? rawError
        : str(asObject(rawError), ['message', 'description', 'title', 'error']);
    await admin
      .from('messages')
      .update({ meta_status: 'failed', error_reason: reason ?? 'Falha na entrega (sem detalhe do Zernio)' })
      .eq('id', m.id);
    return;
  }
  const newRank = RANK[status] ?? 0;
  const prevRank = RANK[m.meta_status ?? ''] ?? 0;
  if (newRank <= prevRank) return;
  await admin.from('messages').update({ meta_status: status }).eq('id', m.id);
}

// Avanca a linha de campaign_contacts correspondente a um envio 1:1 (match por
// zernio_message_id) e os contadores da campanha. Funil monotonico: nunca
// regride; 'replied' e terminal e fica intocado (vem do inbound).
async function syncCampaignContactStatus(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  status: DeliveryStatus,
  zernioMessageId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: cc } = await admin
    .from('campaign_contacts')
    .select('id, campaign_id, status, delivered_at')
    .eq('org_id', orgId)
    .eq('zernio_message_id', zernioMessageId)
    .maybeSingle();
  if (!cc) return;
  const row = cc as { id: string; campaign_id: string; status: string; delivered_at: string | null };
  if (!['sent', 'delivered'].includes(row.status)) return;

  const nowIso = new Date().toISOString();
  if (status === 'failed') {
    const rawError = data.error;
    const reason =
      typeof rawError === 'string' && rawError.trim() !== ''
        ? rawError
        : str(asObject(rawError), ['message', 'description', 'title', 'error']) ?? 'Falha na entrega';
    await admin
      .from('campaign_contacts')
      .update({ status: 'failed', error_message: reason })
      .eq('id', row.id);
    await admin.rpc('bump_campaign_counter', { p_campaign_id: row.campaign_id, p_column: 'failed', p_delta: 1 });
    return;
  }
  if (status === 'sent') return; // ja marcado no dispatch
  if ((RANK[status] ?? 0) <= (RANK[row.status] ?? 0)) return;

  const patch: Record<string, unknown> = { status };
  if (status === 'delivered') patch.delivered_at = nowIso;
  if (status === 'read') {
    patch.read_at = nowIso;
    if (!row.delivered_at) patch.delivered_at = nowIso;
  }
  await admin.from('campaign_contacts').update(patch).eq('id', row.id);
  await admin.rpc('bump_campaign_counter', { p_campaign_id: row.campaign_id, p_column: status, p_delta: 1 });
  if (status === 'read' && row.status === 'sent') {
    await admin.rpc('bump_campaign_counter', { p_campaign_id: row.campaign_id, p_column: 'delivered', p_delta: 1 });
  }
}

async function handleTemplateStatus(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const template = asObject(data.template ?? data);
  const name = str(template, ['name', 'templateName']);
  const metaTemplateId = str(template, ['id', 'templateId', 'meta_template_id']);
  const rawStatus = (str(template, ['status', 'meta_status']) ?? '').toUpperCase();
  if (!name && !metaTemplateId) return;

  const mapped: 'approved' | 'rejected' | 'pending' =
    rawStatus === 'APPROVED'
      ? 'approved'
      : ['REJECTED', 'DISABLED', 'PAUSED'].includes(rawStatus)
        ? 'rejected'
        : 'pending';

  const update: Record<string, unknown> = { meta_template_status: rawStatus || null, status: mapped };
  if (mapped === 'approved') update.approved_at = new Date().toISOString();

  let query = admin.from('templates').update(update).eq('org_id', orgId);
  query = metaTemplateId ? query.eq('meta_template_id', metaTemplateId) : query.eq('name', name as string);
  await query;
}

// whatsapp.number.* → re-resolve e cacheia o status do numero (tier/qualidade/
// saude) no cofre DA ORG. Best-effort: se a chamada falhar, apenas loga.
async function handleNumberEvent(orgId: string, eventType: string): Promise<void> {
  try {
    const ctx = await loadZernioContext(orgId);
    const info = await getNumberInfo(ctx.apiKey, ctx.accountId);
    await setCredential(orgId, 'zernio_number_info', JSON.stringify(info));
  } catch (err) {
    console.error(JSON.stringify({ event: 'zernio_number_refresh_failed', type: eventType, message: err instanceof Error ? err.message : String(err) }));
  }
}

// --- resolução de organização ----------------------------------------------

// A URL registrada no Zernio passa a incluir ?org=<uuid>. Sem org válido,
// caímos no fallback de compatibilidade: se existir exatamente 1 organização
// ativa (webhook registrado antes da migração multi-org), usa-a; senão null.
async function resolveOrgId(
  admin: ReturnType<typeof getAdminClient>,
  orgFromQuery: string | null,
): Promise<{ orgId: string; status: string } | null> {
  if (orgFromQuery) {
    const { data } = await admin
      .from('organizations')
      .select('id, status')
      .eq('id', orgFromQuery)
      .maybeSingle();
    if (data) return { orgId: (data as { id: string }).id, status: (data as { status: string }).status };
    return null; // ?org= presente mas não existe → descartar
  }
  // Fallback legado: única org ativa.
  const { data: actives } = await admin
    .from('organizations')
    .select('id, status')
    .eq('status', 'active')
    .limit(2);
  const rows = (actives ?? []) as Array<{ id: string; status: string }>;
  if (rows.length === 1) return { orgId: rows[0].id, status: rows[0].status };
  return null;
}

// --- entrypoint -------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, { status: 405 });
  }

  const rawBody = await req.text();
  const admin = getAdminClient();

  // Org da query string (?org=<uuid>) com fallback para a única org ativa.
  const orgFromQuery = new URL(req.url).searchParams.get('org');
  const resolved = await resolveOrgId(admin, orgFromQuery);
  if (!resolved) {
    console.log(JSON.stringify({ event: 'zernio_webhook_no_org', org_query: orgFromQuery }));
    return jsonResponse({ ok: true, skipped: 'no_org' });
  }
  const orgId = resolved.orgId;

  // Org arquivada → aceitar (200) e descartar, sem processar.
  if (resolved.status === 'archived') {
    console.log(JSON.stringify({ event: 'zernio_webhook_org_archived', org_id: orgId }));
    return jsonResponse({ ok: true, skipped: 'org_archived' });
  }

  // HMAC com o segredo DA ORG (public.org_settings).
  const secret = await getCredential(orgId, 'zernio_webhook_secret');
  if (!secret) {
    console.error(JSON.stringify({ event: 'zernio_webhook_secret_missing', org_id: orgId }));
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, { status: 500 });
  }

  const signatureHeader = req.headers.get('X-Zernio-Signature') ?? '';
  if (!signatureHeader) {
    return jsonResponse({ ok: false, error: 'Missing signature' }, { status: 401 });
  }
  const mac = await hmacSha256Raw(secret, rawBody);
  if (!signatureMatches(signatureHeader, mac)) {
    return jsonResponse({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const event = normalizeEvent(payload);

  // Idempotencia: registra o event id. Se ja existe (23505), ja foi processado.
  if (event.id) {
    const { error: dupErr } = await admin
      .from('webhook_events')
      .insert({ org_id: orgId, zernio_event_id: event.id, event_type: event.type });
    if (dupErr) {
      if ((dupErr as { code?: string }).code === '23505') {
        return jsonResponse({ ok: true, deduped: true });
      }
      // Falha inesperada no registro: nao bloqueia o processamento.
      console.error(JSON.stringify({ event: 'webhook_event_insert_failed', message: dupErr.message }));
    }
  }

  // Canais suportados no inbox unificado. A plataforma vem em message.platform
  // e/ou account.platform. Outras plataformas (futuras) são ignoradas.
  const SUPPORTED_PLATFORMS = new Set(['whatsapp', 'instagram']);
  const msgPlatform = (
    str(asObject(event.data.message), ['platform']) ??
    str(asObject(event.data.account), ['platform']) ??
    ''
  ).toLowerCase();
  const isMessageEvent = event.type.startsWith('message.');
  if (isMessageEvent && msgPlatform && !SUPPORTED_PLATFORMS.has(msgPlatform)) {
    return jsonResponse({ ok: true, skipped: `platform:${msgPlatform}` });
  }
  const channel: 'whatsapp' | 'instagram' = msgPlatform === 'instagram' ? 'instagram' : 'whatsapp';

  const errors: string[] = [];
  try {
    switch (event.type) {
      case 'message.received':
        await handleMessageReceived(admin, orgId, event.data, errors, channel);
        break;
      case 'message.sent':
        await handleStatus(admin, orgId, 'sent', event.data);
        break;
      case 'message.delivered':
        await handleStatus(admin, orgId, 'delivered', event.data);
        break;
      case 'message.read':
        await handleStatus(admin, orgId, 'read', event.data);
        break;
      case 'message.failed':
        await handleStatus(admin, orgId, 'failed', event.data);
        break;
      case 'whatsapp.template.status_updated':
        await handleTemplateStatus(admin, orgId, event.data);
        break;
      case 'account.disconnected':
        console.error(JSON.stringify({ event: 'zernio_account_disconnected', data: event.data }));
        break;
      default:
        if (event.type.startsWith('whatsapp.number.')) {
          await handleNumberEvent(orgId, event.type);
        }
        // Eventos desconhecidos: aceitar (200) para o Zernio nao re-tentar.
        break;
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'zernio_webhook_handler_error', type: event.type, message: err instanceof Error ? err.message : String(err) }));
    return jsonResponse({ ok: false, error: 'handler error' }, { status: 500 });
  }

  return jsonResponse({ ok: true, type: event.type, errors });
});
