// ============================================================================
// check-follow-ups  (cron target, 15min)
// ----------------------------------------------------------------------------
// Motor das regras de follow-up (aba Automações → Follow-ups). Três gatilhos:
//
//  · no_reply     — reengajamento de broadcast (caminho clássico): enfileira
//                   nova linha em campaign_contacts com template_id_override;
//                   o dispatch-campaign envia via Zernio Broadcast. Agora
//                   também bumpa campaigns.total_contacts (fix do progresso
//                   >100% — antes só `sent` crescia).
//  · inactivity   — conversa sem movimento há delay_hours: envia direto 1:1
//                   (API oficial via template aprovado OU UAZAPI via texto).
//  · no_purchase  — cliente sem compra há params.days dias: mesmo envio 1:1.
//
// Canal por regra (`provider`): 'zernio' (oficial — template aprovado, abre
// janela) ou 'uazapi' (não oficial — message_text livre; risco de banimento
// maior, avisado na UI). Dedup dos gatilhos 1:1 via follow_up_log (1 disparo
// por regra × contato). Filtros opcionais em params: temperature, lead_type,
// tag_id.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import {
  createInboxConversation,
  sendInboxTemplate,
  type ZernioContext,
} from '../_shared/zernio.ts';
import { uazapiContextFromChannel, uazapiSendText, type UazapiContext } from '../_shared/uazapi.ts';
import { getSoleUazapiChannel, loadOrgZernioContext } from '../_shared/channels.ts';

interface FollowUpRule {
  id: string;
  org_id: string;
  campaign_id: string | null;
  trigger_condition: 'no_reply' | 'inactivity' | 'no_purchase';
  delay_hours: number;
  template_id: string | null;
  sequence_order: number;
  is_active: boolean;
  provider: 'zernio' | 'uazapi';
  message_text: string | null;
  params: Record<string, unknown>;
}

interface TargetContact {
  contact_id: string;
  conversation_id: string | null;
  phone: string | null;
  zernio_conversation_id: string | null;
  conv_provider: string | null;
  channel_id: string | null;
}

type Admin = ReturnType<typeof getAdminClient>;

const PER_RULE_LIMIT = 200;

function renderPreview(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_w, n: string) => params[Number(n) - 1] ?? `{{${n}}}`);
}

function countVariables(body: string): number {
  return new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
}

// Filtros opcionais da regra (temperature / lead_type / tag_id) — aplicados
// sobre os contatos candidatos consultando deals/contact_tags.
async function applyRuleFilters(
  admin: Admin,
  contactIds: string[],
  rule: FollowUpRule,
): Promise<Set<string>> {
  const params = rule.params;
  let allowed = new Set(contactIds);
  const temperature = typeof params.temperature === 'string' ? params.temperature : null;
  const leadType = typeof params.lead_type === 'string' ? params.lead_type : null;
  const tagId = typeof params.tag_id === 'string' ? params.tag_id : null;

  if (temperature || leadType) {
    let q = admin.from('deals').select('contact_id').eq('org_id', rule.org_id).in('contact_id', [...allowed]);
    if (temperature) q = q.eq('temperature', temperature);
    if (leadType) q = q.eq('lead_type', leadType);
    const { data } = await q;
    allowed = new Set(((data ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id));
  }
  if (tagId && allowed.size > 0) {
    const { data } = await admin
      .from('contact_tags')
      .select('contact_id')
      .eq('org_id', rule.org_id)
      .in('contact_id', [...allowed])
      .eq('tag_id', tagId);
    allowed = new Set(((data ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id));
  }
  return allowed;
}

// Envio 1:1 do follow-up (inactivity / no_purchase) + persistência na inbox.
async function sendDirectFollowUp(
  admin: Admin,
  rule: FollowUpRule,
  target: TargetContact,
  zctx: ZernioContext | null,
  uctx: UazapiContext | null,
): Promise<void> {
  if (!target.phone) throw new Error('contato sem telefone');

  let content: string;
  let contentType: 'text' | 'template';
  let externalId: string | null = null;

  if (rule.provider === 'uazapi') {
    if (!uctx) throw new Error('UAZAPI não configurada');
    const text = (rule.message_text ?? '').trim();
    if (!text) throw new Error('regra UAZAPI sem message_text');
    const sent = await uazapiSendText(uctx, { phone: target.phone, text });
    externalId = sent.messageId;
    content = text;
    contentType = 'text';
  } else {
    if (!zctx) throw new Error('Zernio não configurado');
    if (!rule.template_id) throw new Error('regra oficial sem template');
    const { data: tpl } = await admin
      .from('templates')
      .select('name, language, body, status')
      .eq('id', rule.template_id)
      .maybeSingle();
    const template = tpl as { name: string; language: string; body: string; status: string } | null;
    if (!template || template.status !== 'approved') throw new Error('template não aprovado');

    const paramValues = Array.isArray(rule.params.template_params)
      ? (rule.params.template_params as unknown[]).map((p) => String(p ?? ''))
      : [];
    const varCount = countVariables(template.body);
    const components = varCount > 0
      ? [{
          type: 'body',
          parameters: Array.from({ length: varCount }, (_, i) => ({ type: 'text', text: paramValues[i] ?? '' })),
        }]
      : [];

    // Resolve/cria a conversa 1:1 no Zernio (template abre a janela de 24h).
    let zConvId = target.conv_provider === 'uazapi' ? null : target.zernio_conversation_id;
    if (!zConvId) {
      const created = await createInboxConversation({
        apiKey: zctx.apiKey,
        accountId: zctx.accountId,
        participantId: target.phone,
      });
      zConvId = created.conversationId;
      if (zConvId && target.conversation_id) {
        await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', target.conversation_id);
      }
    }
    if (!zConvId) throw new Error('não resolveu a conversa no Zernio');
    const sent = await sendInboxTemplate({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      conversationId: zConvId,
      name: template.name,
      language: template.language,
      components,
    });
    externalId = sent.messageId;
    content = renderPreview(template.body, paramValues);
    contentType = 'template';
  }

  // Persistência na inbox (sender_type system — automação, não operador).
  let conversationId = target.conversation_id;
  if (!conversationId) {
    const { data: conv } = await admin
      .from('conversations')
      .insert({
        contact_id: target.contact_id,
        status: 'ai_active',
        channel: 'whatsapp',
        provider: rule.provider === 'uazapi' ? 'uazapi' : 'zernio',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    conversationId = (conv as { id: string } | null)?.id ?? null;
  }
  if (conversationId) {
    await admin.from('messages').insert({
      conversation_id: conversationId,
      direction: 'outbound',
      sender_type: 'system',
      content_type: contentType,
      content,
      zernio_message_id: externalId,
      meta_status: 'sent',
      is_private_note: false,
    });
    await admin
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
  }
}

// Candidatos por gatilho -------------------------------------------------------

// inactivity: conversas abertas paradas (last_message_at < cutoff) DA ORG da regra.
async function inactivityTargets(admin: Admin, rule: FollowUpRule): Promise<TargetContact[]> {
  const cutoff = new Date(Date.now() - rule.delay_hours * 3600 * 1000).toISOString();
  const { data } = await admin
    .from('conversations')
    .select('id, contact_id, zernio_conversation_id, provider, channel_id, contact:contact_id(phone)')
    .eq('org_id', rule.org_id)
    .neq('status', 'closed')
    .lte('last_message_at', cutoff)
    .limit(PER_RULE_LIMIT);
  return ((data ?? []) as unknown as Array<{
    id: string;
    contact_id: string;
    zernio_conversation_id: string | null;
    provider: string | null;
    channel_id: string | null;
    contact: { phone: string | null } | null;
  }>).map((c) => ({
    contact_id: c.contact_id,
    conversation_id: c.id,
    phone: c.contact?.phone ?? null,
    zernio_conversation_id: c.zernio_conversation_id,
    conv_provider: c.provider,
    channel_id: c.channel_id,
  }));
}

// no_purchase: clientes sem compra há params.days dias.
async function noPurchaseTargets(admin: Admin, rule: FollowUpRule): Promise<TargetContact[]> {
  const days = Number(rule.params.days) || Math.max(1, Math.round(rule.delay_hours / 24));
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: deals } = await admin
    .from('deals')
    .select('contact_id, last_purchase_at')
    .eq('org_id', rule.org_id)
    .eq('lead_type', 'Cliente')
    .not('last_purchase_at', 'is', null)
    .lte('last_purchase_at', cutoff)
    .limit(PER_RULE_LIMIT);
  const contactIds = [...new Set(((deals ?? []) as Array<{ contact_id: string }>).map((d) => d.contact_id))];
  if (contactIds.length === 0) return [];
  const { data: convs } = await admin
    .from('conversations')
    .select('id, contact_id, zernio_conversation_id, provider, channel_id')
    .eq('org_id', rule.org_id)
    .in('contact_id', contactIds);
  const convByContact = new Map(
    ((convs ?? []) as Array<{ id: string; contact_id: string; zernio_conversation_id: string | null; provider: string | null; channel_id: string | null }>).map(
      (c) => [c.contact_id, c],
    ),
  );
  const { data: contacts } = await admin.from('contacts').select('id, phone').eq('org_id', rule.org_id).in('id', contactIds);
  return ((contacts ?? []) as Array<{ id: string; phone: string | null }>).map((c) => {
    const conv = convByContact.get(c.id) ?? null;
    return {
      contact_id: c.id,
      conversation_id: conv?.id ?? null,
      phone: c.phone,
      zernio_conversation_id: conv?.zernio_conversation_id ?? null,
      conv_provider: conv?.provider ?? null,
      channel_id: conv?.channel_id ?? null,
    };
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const admin = getAdminClient();

  const { data: rules, error: rulesErr } = await admin
    .from('follow_up_rules')
    .select('id, org_id, campaign_id, trigger_condition, delay_hours, template_id, sequence_order, is_active, provider, message_text, params')
    .eq('is_active', true);
  if (rulesErr) return jsonResponse({ ok: false, error: rulesErr.message }, { status: 500 });

  const active = (rules ?? []) as FollowUpRule[];
  if (active.length === 0) return jsonResponse({ ok: true, enqueued: 0, sent: 0, rules: 0 });

  // Só orgs ativas — regras de orgs arquivadas são puladas.
  const ruleOrgIds = [...new Set(active.map((r) => r.org_id))];
  const { data: activeOrgRows } = await admin
    .from('organizations')
    .select('id')
    .eq('status', 'active')
    .in('id', ruleOrgIds);
  const activeOrgs = new Set(((activeOrgRows ?? []) as Array<{ id: string }>).map((o) => o.id));

  // Contextos resolvidos POR ORG sob demanda (cache no request). O envio direto
  // 1:1 usa o contexto da org dona da regra: Zernio (template) ou UAZAPI (texto).
  const zctxByOrg = new Map<string, ZernioContext | null>();
  const uctxByOrg = new Map<string, UazapiContext | null>();
  const zctxOf = async (orgId: string): Promise<ZernioContext | null> => {
    if (zctxByOrg.has(orgId)) return zctxByOrg.get(orgId) ?? null;
    let ctx: ZernioContext | null = null;
    try { ctx = await loadOrgZernioContext(admin, orgId); } catch { /* regra oficial falha com erro claro */ }
    zctxByOrg.set(orgId, ctx);
    return ctx;
  };
  const uctxOf = async (orgId: string): Promise<UazapiContext | null> => {
    if (uctxByOrg.has(orgId)) return uctxByOrg.get(orgId) ?? null;
    let ctx: UazapiContext | null = null;
    try {
      const channel = await getSoleUazapiChannel(admin, orgId);
      if (channel) ctx = await uazapiContextFromChannel(channel);
    } catch { /* regra uazapi falha com erro claro */ }
    uctxByOrg.set(orgId, ctx);
    return ctx;
  };

  let totalEnqueued = 0;
  let totalSent = 0;
  const errors: string[] = [];

  for (const rule of active) {
    try {
      // Org arquivada: pula a regra inteira.
      if (!activeOrgs.has(rule.org_id)) continue;

      // ---- no_reply: caminho clássico via campaign_contacts/broadcast ------
      if (rule.trigger_condition === 'no_reply') {
        if (!rule.template_id) continue; // regra malformada
        const cutoff = new Date(Date.now() - rule.delay_hours * 3600 * 1000).toISOString();
        let query = admin
          .from('campaign_contacts')
          .select('id, campaign_id, contact_id, sent_at')
          .eq('org_id', rule.org_id)
          .in('status', ['sent', 'delivered', 'read'])
          .is('replied_at', null)
          .is('template_id_override', null)
          .lte('sent_at', cutoff)
          .limit(500);
        if (rule.campaign_id) query = query.eq('campaign_id', rule.campaign_id);
        const { data: eligible, error: eligErr } = await query;
        if (eligErr) { errors.push(`rule ${rule.id}: ${eligErr.message}`); continue; }
        const batch = (eligible ?? []) as Array<{ id: string; campaign_id: string; contact_id: string }>;
        if (batch.length === 0) continue;

        // Dedupe durável: template_id_override persiste após envio.
        const contactIds = batch.map((b) => b.contact_id);
        const { data: alreadyEnq } = await admin
          .from('campaign_contacts')
          .select('contact_id')
          .eq('org_id', rule.org_id)
          .in('contact_id', contactIds)
          .eq('template_id_override', rule.template_id);
        const seen = new Set(((alreadyEnq ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));

        const toInsert = batch
          .filter((b) => !seen.has(b.contact_id))
          .map((b) => ({
            campaign_id: b.campaign_id,
            contact_id: b.contact_id,
            status: 'pending' as const,
            template_id_override: rule.template_id,
            error_message: `Follow-up (ordem ${rule.sequence_order})`,
          }));
        if (toInsert.length === 0) continue;

        const { error: insErr } = await admin.from('campaign_contacts').insert(toInsert);
        if (insErr) { errors.push(`rule ${rule.id}: insert: ${insErr.message}`); continue; }

        // Reabre campanhas concluídas E bumpa total_contacts — sem isso o
        // progresso do card passa de 100% (sent cresce, total não).
        const byCampaign = new Map<string, number>();
        for (const r of toInsert) byCampaign.set(r.campaign_id, (byCampaign.get(r.campaign_id) ?? 0) + 1);
        for (const [campaignId, count] of byCampaign) {
          await admin
            .from('campaigns')
            .update({ status: 'sending', completed_at: null })
            .eq('id', campaignId)
            .eq('status', 'completed');
          await admin.rpc('bump_campaign_counter', {
            p_campaign_id: campaignId,
            p_column: 'total_contacts',
            p_delta: count,
          });
        }
        totalEnqueued += toInsert.length;
        continue;
      }

      // ---- inactivity / no_purchase: envio direto 1:1 ----------------------
      const targets = rule.trigger_condition === 'inactivity'
        ? await inactivityTargets(admin, rule)
        : await noPurchaseTargets(admin, rule);
      if (targets.length === 0) continue;

      // Dedup por regra×contato (follow_up_log) + filtros opcionais.
      const ids = targets.map((t) => t.contact_id);
      const { data: logged } = await admin
        .from('follow_up_log')
        .select('contact_id')
        .eq('rule_id', rule.id)
        .in('contact_id', ids);
      const done = new Set(((logged ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id));
      const allowed = await applyRuleFilters(admin, ids.filter((id) => !done.has(id)), rule);

      // Contextos da org da regra (Zernio p/ template, UAZAPI p/ texto).
      const zctx = rule.provider === 'zernio' ? await zctxOf(rule.org_id) : null;
      const uctx = rule.provider === 'uazapi' ? await uctxOf(rule.org_id) : null;

      for (const target of targets) {
        if (done.has(target.contact_id) || !allowed.has(target.contact_id)) continue;
        try {
          await sendDirectFollowUp(admin, rule, target, zctx, uctx);
          await admin.from('follow_up_log').insert({ rule_id: rule.id, contact_id: target.contact_id });
          totalSent++;
        } catch (err) {
          errors.push(`rule ${rule.id} contato ${target.contact_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jsonResponse({ ok: true, rules: active.length, enqueued: totalEnqueued, sent: totalSent, errors });
});
