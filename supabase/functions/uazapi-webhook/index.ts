// ============================================================================
// uazapi-webhook — receptor dos eventos da instância UAZAPI (integração direta)
// ----------------------------------------------------------------------------
// Cadastrado pela api/uazapi-connect com URL
//   {SUPABASE_URL}/functions/v1/uazapi-webhook?secret=<uazapi_webhook_secret>
// (a UAZAPI não assina HMAC — o gate é o secret na URL, comparação
// constant-time). Config do webhook: events connection+messages, excluindo
// wasSentByApi (anti-loop) e isGroupYes (sem grupos) — os filtros também são
// re-checados aqui por defesa.
//
// Payload: { event, instance, data } com data.message =
//   { id, messageid, chatid, sender, senderName, isGroup, fromMe, messageType,
//     text, fileURL, wasSentByApi, ... }
//
// message → find/create contact (telefone do chatid) + conversation
// (channel 'whatsapp', provider 'uazapi', SEM janela de 24h no inbox) + insert
// em messages. O INSERT dispara a IA via trigger do banco (mesmo caminho do
// zernio-webhook). connection → log.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  getChannelByWebhookSecret,
  getSoleUazapiChannel,
  type ChannelRow,
} from '../_shared/channels.ts';
import { uazapiContextFromChannel, uazapiGetChatDetails } from '../_shared/uazapi.ts';
import { maybeAddLeadToFunnel } from '../_shared/funnel.ts';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

// '5531999999999@s.whatsapp.net' | '5531...@c.us' → '+5531999999999'
function phoneFromJid(jid: string | null): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `+${digits}`;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// messageType da UAZAPI (estilo whatsmeow: Conversation, ImageMessage,
// AudioMessage, PTT, VideoMessage, DocumentMessage, StickerMessage...).
function decodeContent(message: Record<string, unknown>): {
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document';
  content: string | null;
  mediaUrl: string | null;
} {
  const text = str(message, ['text', 'caption', 'body']);
  const mediaUrl = str(message, ['fileURL', 'fileUrl', 'file_url', 'mediaUrl']);
  const type = (str(message, ['messageType', 'type']) ?? '').toLowerCase();

  if (!mediaUrl) return { contentType: 'text', content: text ?? '', mediaUrl: null };
  if (type.includes('image') || type.includes('sticker')) {
    return { contentType: 'image', content: text, mediaUrl };
  }
  if (type.includes('audio') || type.includes('ptt')) {
    return { contentType: 'audio', content: null, mediaUrl };
  }
  if (type.includes('video')) return { contentType: 'video', content: text, mediaUrl };
  return { contentType: 'document', content: text, mediaUrl };
}

interface ContactRow {
  id: string;
  profile_pic_updated_at: string | null;
}

async function findOrCreateContact(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  phone: string,
  name: string | null,
): Promise<ContactRow | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id, profile_pic_updated_at')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) return existing as ContactRow;
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, phone, name, source: 'whatsapp' })
    .select('id, profile_pic_updated_at')
    .single();
  if (error) return null;
  return created as ContactRow;
}

async function findOrCreateConversation(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  contactId: string,
  channel: ChannelRow,
  leadTitle: string | null,
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await admin
    .from('conversations')
    .select('id, provider, channel_id')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; provider: string | null; channel_id: string | null };
    // Último inbound decide o provedor da conversa (e o número de resposta).
    // Não sobrescreve a atribuição de operador de conversas já existentes.
    const patch: Record<string, unknown> = { last_message_at: nowIso };
    if (row.provider !== 'uazapi') patch.provider = 'uazapi';
    if (row.channel_id !== channel.id) patch.channel_id = channel.id;
    await admin.from('conversations').update(patch).eq('id', row.id);
    return row.id;
  }
  const insert: Record<string, unknown> = {
    org_id: orgId,
    contact_id: contactId,
    status: 'ai_active',
    channel: 'whatsapp',
    provider: 'uazapi',
    channel_id: channel.id,
    last_message_at: nowIso,
  };
  // Atribuição automática: conversa nova herda o operador do canal (se houver).
  if (channel.assigned_member) {
    insert.assigned_to = channel.assigned_member;
    insert.assigned_at = nowIso;
  }
  const { data: created, error } = await admin
    .from('conversations')
    .insert(insert)
    .select('id')
    .single();
  if (error) return null;
  const conversationId = (created as { id: string }).id;
  // Lead novo entrando em contato: adiciona ao funil configurado do canal.
  await maybeAddLeadToFunnel(admin, orgId, contactId, channel, leadTitle, 'whatsapp');
  // IA desligada neste número: a conversa nasce direto no humano. O UPDATE
  // (não o INSERT) faz o flip ai_paused false→true, que dispara os triggers
  // de handoff — notifica o operador vinculado ou cai no rodízio/fanout.
  if (channel.ai_enabled === false) {
    await admin
      .from('conversations')
      .update({ status: 'human_active', ai_paused: true })
      .eq('id', conversationId);
  }
  return conversationId;
}

// Foto de perfil do lead: só a UAZAPI expõe. Best-effort, fora do caminho
// crítico do webhook — refresh quando nunca buscamos ou faz mais de 7 dias.
const PROFILE_PIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function shouldRefreshProfilePic(updatedAt: string | null): boolean {
  if (!updatedAt) return true;
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > PROFILE_PIC_TTL_MS;
}

function refreshProfilePic(
  admin: ReturnType<typeof getAdminClient>,
  channel: ChannelRow,
  contactId: string,
  phone: string,
): void {
  const refresh = (async () => {
    const ctx = await uazapiContextFromChannel(channel);
    const details = await uazapiGetChatDetails(ctx, { phone, preview: true });
    if (details.imageUrl) {
      await admin.from('contacts').update({
        profile_pic_url: details.imageUrl,
        profile_pic_updated_at: new Date().toISOString(),
      }).eq('id', contactId);
    } else {
      // Sem foto (privacidade / sem imagem): carimba o timestamp para respeitar
      // o TTL e não re-tentar a cada mensagem.
      await admin.from('contacts').update({
        profile_pic_updated_at: new Date().toISOString(),
      }).eq('id', contactId);
    }
  })().catch((err) =>
    console.log(JSON.stringify({ event: 'uazapi_profile_pic_error', error: String(err) })));
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime?.waitUntil?.(refresh);
}

async function handleMessage(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  channel: ChannelRow,
  data: Record<string, unknown>,
  errors: string[],
): Promise<void> {
  const message = asObject(data.message ?? data);

  const isGroup = message.isGroup === true;
  const sentByApi = message.wasSentByApi === true;
  const fromMe = message.fromMe === true;
  // Grupos: fora de escopo. wasSentByApi: mensagens que NÓS enviamos pela API
  // (send-operator-*) já entram na inbox no envio — ignorar (anti-loop).
  // fromMe SEM wasSentByApi = o dono digitou direto no WhatsApp do celular →
  // registramos como mensagem OUTBOUND do próprio dono (sender_type 'owner').
  if (isGroup || sentByApi) return;

  // chatid é sempre o OUTRO lado do 1:1 (o lead), tanto no inbound quanto no
  // fromMe. No fromMe NÃO caímos em `sender` (que seria o próprio dono).
  // UAZAPI varia a chave do JID por versão: chatid, chatId, remoteJid,
  // remote_jid, chatID. Para fromMe também tentamos 'to'/'recipient'.
  const phone =
    phoneFromJid(str(message, ['chatid', 'chatId', 'chatID', 'remoteJid', 'remote_jid'])) ??
    (fromMe
      ? phoneFromJid(str(message, ['to', 'recipient']))
      : phoneFromJid(str(message, ['sender', 'from']))) ??
    phoneFromJid(str(asObject(data.chat), ['id', 'wa_chatid', 'remoteJid'])) ??
    phoneFromJid(str(asObject(asObject(message.key), ['remoteJid'])));
  if (!phone) {
    errors.push('mensagem uazapi sem telefone');
    return;
  }
  // No fromMe o senderName é o DONO — não usar como nome do lead.
  const name = fromMe
    ? null
    : (str(message, ['senderName', 'pushName']) ?? str(asObject(data.chat), ['name']));
  const uazapiMessageId = str(message, ['messageid', 'id']);

  const contact = await findOrCreateContact(admin, orgId, phone, name);
  if (!contact) {
    errors.push(`contato falhou: ${phone}`);
    return;
  }

  // Foto de perfil do lead (best-effort, não bloqueia a resposta do webhook).
  if (shouldRefreshProfilePic(contact.profile_pic_updated_at)) {
    refreshProfilePic(admin, channel, contact.id, phone);
  }

  const conversationId = await findOrCreateConversation(
    admin, orgId, contact.id, channel, name ?? phone,
  );
  if (!conversationId) {
    errors.push('conversa falhou');
    return;
  }

  // Dedup at-least-once pelo id da mensagem (compartilha a coluna
  // zernio_message_id — é o id externo genérico da mensagem), por org.
  if (uazapiMessageId) {
    const { data: dup } = await admin
      .from('messages')
      .select('id')
      .eq('org_id', orgId)
      .eq('zernio_message_id', uazapiMessageId)
      .maybeSingle();
    if (dup) return;
  }

  const { contentType, content, mediaUrl } = decodeContent(message);
  const { error: insErr } = await admin.from('messages').insert({
    org_id: orgId,
    conversation_id: conversationId,
    direction: fromMe ? 'outbound' : 'inbound',
    sender_type: fromMe ? 'owner' : 'contact',
    content_type: contentType,
    content,
    media_url: mediaUrl,
    zernio_message_id: uazapiMessageId,
    is_private_note: false,
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') return; // corrida de dedup
    errors.push(`message insert: ${insErr.message}`);
    return;
  }

  // Mensagem enviada pelo DONO direto do celular: ele assumiu a conversa, então
  // pausamos a IA (o flip ai_paused false→true dispara os triggers de handoff —
  // round-robin/notify já existentes). Não incrementa não-lidas (é outbound)
  // nem cancela follow-ups (não é resposta do lead).
  if (fromMe) {
    await admin
      .from('conversations')
      .update({ status: 'human_active', ai_paused: true })
      .eq('id', conversationId);
    return;
  }

  await admin.rpc('increment_unread_count', { p_conversation_id: conversationId });

  // Resposta do contato cancela follow-ups pendentes (mesma regra do Zernio).
  const { data: ccHit } = await admin
    .from('campaign_contacts')
    .select('id, campaign_id')
    .eq('org_id', orgId)
    .eq('contact_id', contact.id)
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

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, { status: 405 });
  }

  const admin = getAdminClient();
  const secret = new URL(req.url).searchParams.get('secret') ?? '';

  // Roteamento por canal: o secret na URL É a autenticação (a UAZAPI não assina
  // HMAC). Cada canal tem seu próprio webhook_secret → resolve org + canal.
  let channel: ChannelRow | null = secret
    ? await getChannelByWebhookSecret(admin, secret)
    : null;

  if (!channel) {
    // Fallback legado: instância única migrada de antes do multi-canal. Só
    // aceita se houver exatamente 1 org ativa com 1 canal uazapi, e o secret
    // da URL casar (timing-safe) com o webhook_secret desse canal.
    const { data: actives } = await admin
      .from('organizations')
      .select('id')
      .eq('status', 'active')
      .limit(2);
    const activeRows = (actives ?? []) as Array<{ id: string }>;
    if (activeRows.length === 1) {
      const sole = await getSoleUazapiChannel(admin, activeRows[0].id);
      if (sole && secret && timingSafeEqualStr(secret, sole.webhook_secret)) {
        channel = sole;
      }
    }
  }

  if (!channel) {
    console.log(JSON.stringify({ event: 'uazapi_webhook_no_channel' }));
    return jsonResponse({ ok: true, skipped: 'no_channel' });
  }
  const orgId = channel.org_id;

  // Org arquivada → aceitar (200) e descartar.
  const { data: org } = await admin
    .from('organizations')
    .select('status')
    .eq('id', orgId)
    .maybeSingle();
  if ((org as { status: string } | null)?.status === 'archived') {
    console.log(JSON.stringify({ event: 'uazapi_webhook_org_archived', org_id: orgId }));
    return jsonResponse({ ok: true, skipped: 'org_archived' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const root = asObject(payload);
  const eventType = (str(root, ['event', 'EventType', 'type']) ?? '').toLowerCase();
  const data = asObject(root.data ?? root);

  console.log(JSON.stringify({ event: 'uazapi_webhook_received', type: eventType, org_id: orgId }));

  const errors: string[] = [];
  try {
    // UAZAPI varia o nome do evento por versão:
    //   'messages.upsert', 'message.received', 'NewMessage', 'MESSAGE', 'new_message'...
    // Verificamos tanto prefixo 'message' quanto variantes comuns.
    const isMessageEvent =
      eventType.startsWith('message') ||
      eventType === 'newmessage' ||
      eventType === 'new_message' ||
      eventType.includes('message');
    const isConnectionEvent =
      eventType.startsWith('connection') || eventType.includes('connection');

    if (isMessageEvent) {
      await handleMessage(admin, orgId, channel, data, errors);
    } else if (isConnectionEvent) {
      console.log(JSON.stringify({ event: 'uazapi_connection', data: root.data ?? null }));
    }
    // Outros eventos: registrados no log acima, sem ação.
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({ event: 'uazapi_webhook_errors', errors }));
  }
  return jsonResponse({ ok: true, errors: errors.length > 0 ? errors : undefined });
});
