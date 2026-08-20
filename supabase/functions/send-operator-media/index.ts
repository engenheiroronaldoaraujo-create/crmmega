// ============================================================================
// send-operator-media
// ----------------------------------------------------------------------------
// Operador anexa uma mídia (imagem/áudio/vídeo/documento) numa conversa. O
// arquivo chega como multipart/form-data; subimos ao Zernio via
// /media/upload-direct (máx 25MB), enviamos a mensagem com attachmentUrl pela
// inbox 1:1 e persistimos a linha (content_type + media_url = url do Zernio)
// para o thread renderizar. A ZERNIO_API_KEY nunca toca o browser.
//
// Notas privadas NÃO passam por aqui — são texto e nunca vão ao Zernio.
// ============================================================================

import { requireOrgCaller, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { ZernioError, uploadMediaDirect } from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';
import { sendInboxWithResolve } from '../_shared/inbox-delivery.ts';

const MAX_BYTES = 25 * 1024 * 1024;

function classify(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireOrgCaller(req);
    if (caller.role !== 'admin' && caller.role !== 'operator') {
      return jsonResponse({ ok: false, error: 'Sem permissão para enviar mensagens.' }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonResponse({ ok: false, error: 'Esperado multipart/form-data.' }, { status: 400 });
    }

    const conversationId = String(form.get('conversation_id') ?? '').trim();
    const caption = String(form.get('content') ?? '').trim();
    const voiceNote = String(form.get('voice_note') ?? '') === 'true';
    const file = form.get('file');

    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'conversation_id ausente.' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return jsonResponse({ ok: false, error: 'Arquivo ausente.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'Arquivo excede 25MB.' }, { status: 400 });
    }

    const admin = getAdminClient();

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, org_id, contact_id, channel, channel_id, zernio_conversation_id, zernio_account_id, provider')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) return jsonResponse({ ok: false, error: convErr.message }, { status: 500 });
    if (!conv) return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    const convRow = conv as {
      id: string;
      org_id: string;
      contact_id: string;
      channel: 'whatsapp' | 'instagram' | null;
      channel_id?: string | null;
      zernio_conversation_id: string | null;
      zernio_account_id?: string | null;
      provider?: string | null;
    };
    // Cross-check de org: a conversa deve pertencer à org do caller.
    if (convRow.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    }
    const channel = convRow.channel === 'instagram' ? 'instagram' : 'whatsapp';

    const contentType = classify(file.type || '');
    const mime = file.type || 'application/octet-stream';
    const filename = voiceNote ? 'voice-note.ogg' : (file.name || `arquivo-${contentType}`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    // 1. Sobe a mídia ao Zernio (host da URL usada no attachmentUrl, inclusive
    //    para conversas UAZAPI que enviam a URL direto pela instância).
    const zernio = await loadOrgZernioContext(admin, caller.orgId, convRow.zernio_account_id ?? null);
    const mediaUrl = await uploadMediaDirect({ apiKey: zernio.apiKey, bytes, filename, contentType: mime });

    // 2. Resolve a conversa 1:1 no Zernio (por canal) e envia a mídia, curando
    //    o id salvo se o Zernio o rejeitar.
    const { data: contactRow } = await admin
      .from('contacts')
      .select('phone, instagram_id')
      .eq('id', convRow.contact_id)
      .maybeSingle();
    const contact = (contactRow as { phone?: string; instagram_id?: string } | null) ?? {};

    const zernioMessageId = await sendInboxWithResolve(
      admin,
      {
        conversationRowId: conversationId,
        orgId: caller.orgId,
        channel,
        phone: contact.phone ?? null,
        instagramId: contact.instagram_id ?? null,
        storedZernioConversationId: convRow.zernio_conversation_id,
        channelId: convRow.channel_id ?? null,
        zernioAccountId: convRow.zernio_account_id ?? null,
        provider: convRow.provider ?? null,
      },
      { attachmentUrl: mediaUrl, voiceNote, text: caption || undefined },
    );

    // 4. Persiste a linha (media_url = url do Zernio, baixável pelo thread).
    const { data: inserted, error: insErr } = await admin
      .from('messages')
      .insert({
        org_id: caller.orgId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'operator',
        sender_id: caller.userId,
        content_type: contentType,
        content: caption || null,
        media_url: mediaUrl,
        zernio_message_id: zernioMessageId,
        meta_status: 'sent',
        is_private_note: false,
      })
      .select('id')
      .single();
    if (insErr) return jsonResponse({ ok: false, error: insErr.message }, { status: 500 });

    await admin
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        status: 'human_active',
        ai_paused: true,
        assigned_to: caller.userId,
      })
      .eq('id', conversationId);

    return jsonResponse({
      ok: true,
      message_id: (inserted as { id: string }).id,
      media_url: mediaUrl,
      sent_to_zernio: true,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    if (err instanceof ZernioError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status === 401 ? 401 : 502 });
    }
    console.error('send-operator-media error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
