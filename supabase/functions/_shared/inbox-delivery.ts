// ============================================================================
// _shared/inbox-delivery.ts
// ----------------------------------------------------------------------------
// Resolve a conversa 1:1 e envia (texto ou mídia) numa única chamada, roteando
// pelo CANAL da conversa (whatsapp_hub.channels): UAZAPI envia direto pela
// instância; Zernio resolve/auto-corrige o zernio_conversation_id.
//
// Por que existe: o id de conversa entregue no webhook inbound NÃO é aceito por
// POST /inbox/conversations/{id}/messages. O id válido vem de
// GET /inbox/conversations (participantId → id). No WhatsApp resolvemos criando
// a conversa pelo telefone (createInboxConversation); no Instagram não há
// telefone, então casamos o instagram_id na listagem. Se o Zernio responder
// "Conversation not found", re-resolvemos e tentamos uma vez, persistindo o id
// corrigido — assim conversas antigas (com id inbound obsoleto) se curam sozinhas.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';
import {
  createInboxConversation,
  isConversationNotFoundError,
  resolveInboxConversation,
  sendInboxMessage,
} from './zernio.ts';
import { uazapiSendMedia, uazapiSendText } from './uazapi.ts';
import { getSendContextForConversation } from './channels.ts';

type Admin = ReturnType<typeof getAdminClient>;

export interface InboxTarget {
  conversationRowId: string; // whatsapp_hub.conversations.id
  orgId: string; // organização dona da conversa
  channel: 'whatsapp' | 'instagram';
  phone: string | null; // identidade WhatsApp (E.164 / wa_id)
  instagramId: string | null; // identidade Instagram (IG-scoped id)
  storedZernioConversationId: string | null;
  // Canal (número) carimbado na conversa; null em conversas legadas.
  channelId?: string | null;
  // Conta Zernio que RECEBEU a conversa (fallback legado).
  zernioAccountId?: string | null;
  // Provedor da conversa: 'zernio' (Meta oficial / Instagram) × 'uazapi'.
  provider?: string | null;
}

export interface InboxSendPayload {
  text?: string;
  attachmentUrl?: string;
  attachmentType?: 'image' | 'video' | 'audio' | 'file';
  voiceNote?: boolean;
}

interface Resolved {
  conversationId: string;
  accountId: string; // conta do Zernio que DEVE enviar (pode diferir por canal)
}

// Resolve + envia; devolve o zernio message id (ou null). Lança em falha
// definitiva (o chamador registra meta_status='failed').
export async function sendInboxWithResolve(
  admin: Admin,
  target: InboxTarget,
  payload: InboxSendPayload,
): Promise<string | null> {
  const sendCtx = await getSendContextForConversation(admin, {
    org_id: target.orgId,
    channel_id: target.channelId ?? null,
    provider: target.provider ?? null,
    zernio_account_id: target.zernioAccountId ?? null,
  });

  // Conversa UAZAPI: envio direto pela API da instância (sem Zernio). O
  // telefone é o destino; mídia vai como URL (upload já feito pelo caller).
  if (sendCtx.provider === 'uazapi' && target.channel === 'whatsapp') {
    if (!target.phone) throw new Error('Conversa UAZAPI sem telefone.');
    const uctx = sendCtx.uazapi;
    if (payload.attachmentUrl) {
      const type = payload.voiceNote
        ? 'ptt'
        : payload.attachmentType === 'image'
          ? 'image'
          : payload.attachmentType === 'video'
            ? 'video'
            : payload.attachmentType === 'audio'
              ? 'audio'
              : 'document';
      const sent = await uazapiSendMedia(uctx, {
        phone: target.phone,
        type,
        fileUrl: payload.attachmentUrl,
        caption: payload.text,
      });
      return sent.messageId;
    }
    const sent = await uazapiSendText(uctx, { phone: target.phone, text: payload.text ?? '' });
    return sent.messageId;
  }

  if (sendCtx.provider !== 'zernio') {
    throw new Error('Canal da conversa não suporta este envio.');
  }
  const ctx = sendCtx.zernio;

  const persist = async (id: string) => {
    await admin
      .from('conversations')
      .update({ zernio_conversation_id: id })
      .eq('id', target.conversationRowId);
  };

  // (Re)resolve uma conversa VÁLIDA PARA ENVIO conforme o canal.
  //  - Instagram: casa o instagram_id na lista de conversas (sem filtrar pelo
  //    accountId do WhatsApp) e usa o accountId da própria conversa IG.
  //  - WhatsApp: cria/reusa pelo telefone com o accountId do WhatsApp.
  const resolveFresh = async (): Promise<Resolved | null> => {
    if (target.channel === 'instagram') {
      if (!target.instagramId) return null;
      const summary = await resolveInboxConversation({
        apiKey: ctx.apiKey,
        platform: 'instagram',
        participantId: target.instagramId,
      });
      if (!summary) return null;
      return { conversationId: summary.id, accountId: summary.accountId ?? ctx.accountId };
    }
    if (!target.phone) return null;
    const created = await createInboxConversation({
      apiKey: ctx.apiKey,
      accountId: ctx.accountId,
      participantId: target.phone,
    });
    return created.conversationId
      ? { conversationId: created.conversationId, accountId: ctx.accountId }
      : null;
  };

  // WhatsApp reaproveita o id salvo (accountId conhecido — o do canal da
  // conversa). Instagram sempre resolve pela lista para obter o accountId
  // correto da conta IG.
  let resolved: Resolved | null =
    target.channel === 'whatsapp' && target.storedZernioConversationId
      ? { conversationId: target.storedZernioConversationId, accountId: ctx.accountId }
      : await resolveFresh();

  if (resolved && resolved.conversationId !== target.storedZernioConversationId) {
    await persist(resolved.conversationId);
  }
  if (!resolved) {
    throw new Error(
      target.channel === 'instagram'
        ? 'Conversa do Instagram não encontrada no Zernio.'
        : 'Não foi possível resolver a conversa no Zernio.',
    );
  }

  const trySend = async (r: Resolved): Promise<string | null> => {
    const sent = await sendInboxMessage({
      apiKey: ctx.apiKey,
      accountId: r.accountId,
      conversationId: r.conversationId,
      ...payload,
    });
    return sent.messageId;
  };

  try {
    return await trySend(resolved);
  } catch (err) {
    // Auto-heal: id salvo obsoleto → re-resolve pela lista e tenta 1x.
    if (!isConversationNotFoundError(err)) throw err;
    const fresh = await resolveFresh();
    if (!fresh || fresh.conversationId === resolved.conversationId) throw err;
    await persist(fresh.conversationId);
    return await trySend(fresh);
  }
}
