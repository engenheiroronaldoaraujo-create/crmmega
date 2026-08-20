// ============================================================================
// send-operator-template
// ----------------------------------------------------------------------------
// Operador reinicia uma conversa enviando um template aprovado — necessário
// quando o contato está FORA da janela de 24h (a Meta só aceita template fora
// da janela). Persiste a mensagem e marca a conversa como atendimento humano.
// ============================================================================

import { requireOrgCaller, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  ZernioError,
  createInboxConversation,
  sendInboxTemplate,
} from '../_shared/zernio.ts';
import { getSendContextForConversation } from '../_shared/channels.ts';

interface Payload {
  conversation_id?: string;
  template_id?: string;
  params?: string[]; // valores das variáveis, na ordem 1..N
}

function countVariables(body: string): number {
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
  return new Set(matches).size;
}

function renderPreview(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_w, n: string) => params[Number(n) - 1] ?? `{{${n}}}`);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireOrgCaller(req);
    if (caller.role !== 'admin' && caller.role !== 'operator') {
      return jsonResponse({ ok: false, error: 'Sem permissão.' }, { status: 403 });
    }

    let body: Payload;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }
    const conversationId = body.conversation_id?.trim();
    const templateId = body.template_id?.trim();
    const params = Array.isArray(body.params) ? body.params.map((p) => String(p ?? '')) : [];
    if (!conversationId || !templateId) {
      return jsonResponse({ ok: false, error: 'conversation_id e template_id são obrigatórios.' }, { status: 400 });
    }

    const admin = getAdminClient();

    const { data: conv } = await admin
      .from('conversations')
      .select('id, org_id, contact_id, channel_id, zernio_conversation_id, zernio_account_id, provider')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    const convRow = conv as {
      id: string;
      org_id: string;
      contact_id: string;
      channel_id: string | null;
      zernio_conversation_id: string | null;
      zernio_account_id: string | null;
      provider: string | null;
    };
    // Cross-check de org: a conversa deve pertencer à org do caller.
    if (convRow.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    }

    const { data: tpl } = await admin
      .from('templates')
      .select('org_id, name, language, body, status')
      .eq('id', templateId)
      .maybeSingle();
    if (!tpl) return jsonResponse({ ok: false, error: 'Template não encontrado.' }, { status: 404 });
    const template = tpl as { org_id: string; name: string; language: string; body: string; status: string };
    // Cross-check de org: o template deve pertencer à org do caller.
    if (template.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Template não encontrado.' }, { status: 404 });
    }
    if (template.status !== 'approved') {
      return jsonResponse({ ok: false, error: 'Só templates aprovados podem reiniciar a conversa.' }, { status: 400 });
    }

    const varCount = countVariables(template.body);
    const components = varCount > 0
      ? [{ type: 'body', parameters: Array.from({ length: varCount }, (_, i) => ({ type: 'text', text: params[i] ?? '' })) }]
      : [];

    // Templates só existem no provedor oficial (Meta via Zernio). Resolve o
    // contexto de envio pelo canal carimbado na conversa.
    const sendCtx = await getSendContextForConversation(admin, {
      org_id: convRow.org_id,
      channel_id: convRow.channel_id,
      provider: convRow.provider,
      zernio_account_id: convRow.zernio_account_id,
    });
    if (sendCtx.provider !== 'zernio') {
      return jsonResponse({ ok: false, error: 'Templates só podem ser enviados por canais Zernio (Meta oficial).' }, { status: 400 });
    }
    const ctx = sendCtx.zernio;
    let zConvId = convRow.zernio_conversation_id;
    let zernioMessageId: string | null = null;

    if (zConvId) {
      const sent = await sendInboxTemplate({
        apiKey: ctx.apiKey, accountId: ctx.accountId, conversationId: zConvId,
        name: template.name, language: template.language, components,
      });
      zernioMessageId = sent.messageId;
    } else {
      // Sem conversa Zernio: cria pelo telefone (a Meta abre a janela ao enviar template).
      const { data: contactRow } = await admin.from('contacts').select('phone').eq('id', convRow.contact_id).maybeSingle();
      const phone = (contactRow as { phone?: string } | null)?.phone ?? null;
      if (!phone) return jsonResponse({ ok: false, error: 'Contato sem telefone.' }, { status: 400 });
      const created = await createInboxConversation({ apiKey: ctx.apiKey, accountId: ctx.accountId, participantId: phone });
      zConvId = created.conversationId;
      if (zConvId) {
        await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', conversationId);
        const sent = await sendInboxTemplate({
          apiKey: ctx.apiKey, accountId: ctx.accountId, conversationId: zConvId,
          name: template.name, language: template.language, components,
        });
        zernioMessageId = sent.messageId;
      }
    }

    // Persiste a mensagem (preview renderizado) e reabre como atendimento humano.
    const preview = renderPreview(template.body, params);
    const { data: ins } = await admin
      .from('messages')
      .insert({
        org_id: caller.orgId,
        conversation_id: conversationId, direction: 'outbound', sender_type: 'operator',
        sender_id: caller.userId, content_type: 'template', content: preview,
        zernio_message_id: zernioMessageId, meta_status: 'sent', is_private_note: false,
      })
      .select('id').single();

    await admin.from('conversations').update({
      status: 'human_active', ai_paused: true, assigned_to: caller.userId,
      last_message_at: new Date().toISOString(),
    }).eq('id', conversationId);

    return jsonResponse({ ok: true, message_id: (ins as { id: string } | null)?.id ?? null, zernio_message_id: zernioMessageId });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    if (err instanceof ZernioError) return jsonResponse({ ok: false, error: err.message }, { status: err.status === 401 ? 401 : 502 });
    console.error('send-operator-template error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
