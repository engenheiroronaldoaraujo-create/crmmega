// ============================================================================
// simulate-inbound  (dev-only)
// ----------------------------------------------------------------------------
// Lets the admin seed a realistic inbound-message flow without a live Zernio
// webhook. Mirrors what zernio-webhook does: find/create contact, find/create
// conversation, insert an inbound text message. Bumps conversation
// last_message_at + unread_count so the inbox UI updates in realtime.
//
// Intended to be called from a button on the Inbox page during development.
// Disable in production once real Zernio traffic is flowing.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

interface Payload {
  phone?: string;
  name?: string;
  content?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: Payload;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    const rawPhone = (body.phone ?? '').trim();
    const name = (body.name ?? '').trim() || 'Simulado';
    const content = (body.content ?? '').trim() || 'Olá, tudo bem?';

    if (!rawPhone) {
      return jsonResponse({ ok: false, error: 'phone ausente.' }, { status: 400 });
    }

    // Validate E.164 format (dev tool seeds the contacts table, so we don't
    // want to pollute it with garbage like "not-a-phone").
    const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return jsonResponse(
        { ok: false, error: 'phone inválido. Use formato E.164 (ex.: +5511999999999).' },
        { status: 400 },
      );
    }

    if (body.content !== undefined && content === 'Olá, tudo bem?' && (body.content ?? '').trim() === '') {
      // Reject explicit empty content rather than silently falling back to the
      // dev default — that masks bugs in the caller.
      return jsonResponse(
        { ok: false, error: 'content vazio. Passe um texto ou omita o campo para usar o default.' },
        { status: 400 },
      );
    }

    const admin = getAdminClient();

    // 1. Find or create contact (service_role bypasses RLS so we write
    //    directly; this mirrors meta-webhook semantics).
    let contactId: string;
    const { data: existing } = await admin
      .from('contacts')
      .select('id')
      .eq('org_id', caller.orgId)
      .eq('phone', phone)
      .maybeSingle();
    if (existing) {
      contactId = (existing as { id: string }).id;
    } else {
      const { data: created, error: createErr } = await admin
        .from('contacts')
        .insert({ org_id: caller.orgId, phone, name })
        .select('id')
        .single();
      if (createErr) return jsonResponse({ ok: false, error: createErr.message }, { status: 500 });
      contactId = (created as { id: string }).id;
    }

    // 2. Find or create conversation.
    let conversationId: string;
    const { data: existingConv } = await admin
      .from('conversations')
      .select('id, unread_count')
      .eq('org_id', caller.orgId)
      .eq('contact_id', contactId)
      .maybeSingle();
    if (existingConv) {
      conversationId = (existingConv as { id: string }).id;
    } else {
      const { data: createdConv, error: convErr } = await admin
        .from('conversations')
        .insert({
          org_id: caller.orgId,
          contact_id: contactId,
          status: 'ai_active',
          last_message_at: new Date().toISOString(),
          unread_count: 0,
        })
        .select('id')
        .single();
      if (convErr) return jsonResponse({ ok: false, error: convErr.message }, { status: 500 });
      conversationId = (createdConv as { id: string }).id;
    }

    // 3. Insert inbound message.
    const { data: msg, error: msgErr } = await admin
      .from('messages')
      .insert({
        org_id: caller.orgId,
        conversation_id: conversationId,
        direction: 'inbound',
        sender_type: 'contact',
        content_type: 'text',
        content,
        zernio_message_id: `sim_${Date.now()}`,
      })
      .select('id')
      .single();
    if (msgErr) return jsonResponse({ ok: false, error: msgErr.message }, { status: 500 });

    const priorUnread = (existingConv as { unread_count?: number } | null)?.unread_count ?? 0;
    await admin
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        unread_count: priorUnread + 1,
      })
      .eq('id', conversationId);

    return jsonResponse({
      ok: true,
      conversation_id: conversationId,
      contact_id: contactId,
      message_id: (msg as { id: string }).id,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('simulate-inbound error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
