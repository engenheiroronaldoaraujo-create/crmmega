// ============================================================================
// dispatch-campaign  (cron target, 30s)
// ----------------------------------------------------------------------------
// Disparo em massa via Zernio Broadcasts (substitui o loop por-contato na Meta).
// O Zernio cuida de batching, retry e rate-limit — aqui NAO ha mais loop de
// backoff/tier proprio. Por tick, por campanha em `sending`:
//
//   1. Reserva um lote de campaign_contacts pendentes (FOR UPDATE SKIP LOCKED).
//   2. Agrupa por template efetivo (template_id_override ?? template da campanha)
//      — follow-ups usam template diferente do template-pai.
//   3. Para cada grupo: cria um broadcast, adiciona destinatarios (telefones em
//      lotes de 100), e dispara (`send`). Marca as linhas como 'sent' e grava
//      zernio_broadcast_id por linha (correlacao exata no webhook de status).
//
// Os status sent/delivered/read/failed por destinatario sao reconciliados depois
// pelo job sync-broadcast-status (polling de GET /broadcasts/{id}/recipients) —
// o evento de status do webhook do Zernio nao carrega o broadcastId.
//
// VARIAVEIS: o broadcast personaliza por destinatario via `variableMapping`
// (doc Zernio, "Template Variables") — { field: 'name' } resolve o nome de cada
// contato no envio; { field: 'custom', customValue } e valor fixo p/ todos.
// Suportamos: literal (→ custom) e contact_field 'name' (→ name; contatos sao
// bulk-importados no Zernio com nome antes dos recipients, e linhas de contato
// SEM nome falham em vez de enviar placeholder vazio). email/phone/custom_field
// nao tem equivalente na API de broadcast e falham a linha com motivo legivel.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import {
  ZernioError,
  addBroadcastRecipients,
  bulkCreateContacts,
  createBroadcast,
  createInboxConversation,
  sendBroadcast,
  sendInboxTemplate,
  type BroadcastVariableMapping,
  type ZernioContext,
} from '../_shared/zernio.ts';
import { getChannelById, loadOrgZernioContext } from '../_shared/channels.ts';

// Teto de destinatarios processados por campanha por tick. O Zernio faz o
// batching real; isto so limita o trabalho de um unico tick de 30s.
const PER_TICK_LIMIT = 500;
const RECIPIENTS_CHUNK = 100;

interface CampaignRow {
  id: string;
  org_id: string;
  channel_id: string | null;
  name: string;
  template_id: string;
  status: 'scheduled' | 'sending' | 'paused' | 'completed';
  variable_mapping: Record<string, VariableSource>;
}

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  body: string;
}

interface CampaignContactRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  template_id_override: string | null;
}

type VariableSource =
  | { source: 'literal'; value: string }
  | { source: 'contact_field'; field: 'name' | 'email' | 'phone'; fallback?: string }
  | { source: 'custom_field'; field: string }
  | { source: 'deal_field'; field: 'title' | 'products' | 'value' | 'last_purchase_at'; fallback?: string };

// Variáveis de negócio têm valor diferente por destinatário e o variableMapping
// do broadcast do Zernio só resolve nome/custom — campanhas com deal_field vão
// pelo caminho DIRETO (template 1:1 por destinatário, como os follow-ups).
function usesDealFields(mapping: Record<string, VariableSource> | null, varCount: number): boolean {
  for (let i = 1; i <= varCount; i++) {
    if (mapping?.[String(i)]?.source === 'deal_field') return true;
  }
  return false;
}

// Envios 1:1 são 2 chamadas HTTP por destinatário — teto menor por tick para
// caber na janela do cron de 30s (o restante volta a pending e sai no próximo).
const DIRECT_PER_TICK = 60;
const DIRECT_CONCURRENCY = 4;

function brl(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

// Datas de compra são date-only (sem hora); formata sem passar por Date p/ não
// deslocar o dia com timezone.
function brDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

interface DealData {
  title: string | null;
  value: number | null;
  last_purchase_at: string | null;
  won_at: string | null;
  products: string[];
}

// Deal mais recente por contato + nomes dos produtos dele.
async function loadDealData(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  contactIds: string[],
): Promise<Map<string, DealData>> {
  const out = new Map<string, DealData>();
  if (contactIds.length === 0) return out;
  const { data: deals } = await admin
    .from('deals')
    .select('id, contact_id, title, value, last_purchase_at, won_at, created_at')
    .eq('org_id', orgId)
    .in('contact_id', contactIds)
    .order('created_at', { ascending: false });
  const dealIdByContact = new Map<string, string>();
  for (const row of (deals ?? []) as Array<{
    id: string; contact_id: string; title: string | null; value: number | null;
    last_purchase_at: string | null; won_at: string | null;
  }>) {
    if (out.has(row.contact_id)) continue; // ordenado desc → primeiro = mais recente
    out.set(row.contact_id, {
      title: row.title,
      value: row.value != null ? Number(row.value) : null,
      last_purchase_at: row.last_purchase_at,
      won_at: row.won_at,
      products: [],
    });
    dealIdByContact.set(row.contact_id, row.id);
  }
  const dealIds = [...dealIdByContact.values()];
  if (dealIds.length > 0) {
    const { data: dps } = await admin
      .from('deal_products')
      .select('deal_id, products(name)')
      .in('deal_id', dealIds);
    const namesByDeal = new Map<string, string[]>();
    for (const row of (dps ?? []) as Array<{ deal_id: string; products: { name: string } | { name: string }[] | null }>) {
      const p = Array.isArray(row.products) ? row.products[0] : row.products;
      if (!p?.name) continue;
      const list = namesByDeal.get(row.deal_id) ?? [];
      list.push(p.name);
      namesByDeal.set(row.deal_id, list);
    }
    for (const [contactId, dealId] of dealIdByContact) {
      const data = out.get(contactId);
      if (data) data.products = namesByDeal.get(dealId) ?? [];
    }
  }
  return out;
}

// Resolve o valor de UMA variável para UM contato no caminho direto.
// Retorna null quando não há valor nem fallback (a linha falha com motivo).
function resolveDirectValue(
  src: VariableSource | undefined,
  contactName: string | null,
  deal: DealData | undefined,
): { value: string | null; missingLabel: string | null } {
  if (!src) return { value: null, missingLabel: 'sem mapeamento' };
  if (src.source === 'literal') {
    return src.value.trim() !== ''
      ? { value: src.value, missingLabel: null }
      : { value: null, missingLabel: 'valor fixo vazio' };
  }
  if (src.source === 'contact_field' && src.field === 'name') {
    const v = contactName ?? src.fallback?.trim() ?? null;
    return v ? { value: v, missingLabel: null } : { value: null, missingLabel: 'contato sem nome' };
  }
  if (src.source === 'deal_field') {
    const fb = src.fallback?.trim() || null;
    let v: string | null = null;
    if (src.field === 'title') v = deal?.title?.trim() || null;
    else if (src.field === 'products') v = deal?.products.length ? deal.products.join(', ') : null;
    else if (src.field === 'value') v = deal?.value != null && deal.value > 0 ? brl(deal.value) : null;
    else if (src.field === 'last_purchase_at') {
      const d = deal?.last_purchase_at ?? deal?.won_at ?? null;
      v = d ? brDate(d) : null;
    }
    v = v ?? fb;
    if (v) return { value: v, missingLabel: null };
    const label = {
      title: 'lead sem negócio/título',
      products: 'negócio sem produtos',
      value: 'negócio sem valor',
      last_purchase_at: 'sem data de compra',
    }[src.field];
    return { value: null, missingLabel: label };
  }
  return { value: null, missingLabel: `fonte "${src.source}" não suportada` };
}

// Pool simples de concorrência.
async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function countVariables(body: string): number {
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
  return new Set(matches).size;
}

// Componentes + variableMapping do broadcast a partir do template e do
// mapeamento da campanha. Com variableMapping os parameters do body sao os
// proprios placeholders ({ type:'text', text:'{{n}}' }) e o Zernio resolve por
// destinatario no envio. Variaveis sem resolucao possivel (literal vazio,
// email/phone/custom_field — sem equivalente na API de broadcast) vao para
// `missing` e o chamador FALHA a linha em vez de enviar parametro vazio, que a
// Meta rejeitaria com "Required template parameter is missing" (a mensagem
// nunca chegaria, sem aviso). `needsName` sinaliza que ha { field:'name' } —
// o chamador precisa garantir nome no contato Zernio e no nosso banco.
// `nameFallback` (opcional na variavel de nome) e usado como nome do contato
// quando o nosso banco nao tem um — sem ele, a linha sem nome falha.
function buildBroadcastComponents(
  template: TemplateRow,
  mapping: Record<string, VariableSource> | null,
): {
  components: unknown[];
  variableMapping: BroadcastVariableMapping;
  missing: number[];
  needsName: boolean;
  nameFallback: string | null;
} {
  const varCount = countVariables(template.body);
  if (varCount === 0) {
    return { components: [], variableMapping: {}, missing: [], needsName: false, nameFallback: null };
  }
  const parameters: Array<{ type: 'text'; text: string }> = [];
  const variableMapping: BroadcastVariableMapping = {};
  const missing: number[] = [];
  let needsName = false;
  let nameFallback: string | null = null;
  for (let i = 1; i <= varCount; i++) {
    const src = mapping?.[String(i)];
    parameters.push({ type: 'text', text: `{{${i}}}` });
    if (src?.source === 'literal' && src.value.trim() !== '') {
      variableMapping[String(i)] = { field: 'custom', customValue: src.value };
    } else if (src?.source === 'contact_field' && src.field === 'name') {
      variableMapping[String(i)] = { field: 'name' };
      needsName = true;
      if (!nameFallback && src.fallback?.trim()) nameFallback = src.fallback.trim();
    } else {
      missing.push(i);
    }
  }
  return { components: [{ type: 'body', parameters }], variableMapping, missing, needsName, nameFallback };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Renderiza o corpo do template para o espelho da inbox: literais viram o valor
// fixo; variaveis de nome viram o nome do contato (mesma resolucao que o Zernio
// faz no envio, replicada aqui so para o preview local).
function renderTemplatePreview(
  body: string,
  mapping: Record<string, VariableSource> | null,
  contactName: string | null,
): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_w, n: string) => {
    const src = mapping?.[n];
    if (src?.source === 'literal') return src.value;
    if (src?.source === 'contact_field' && src.field === 'name' && contactName) return contactName;
    return `{{${n}}}`;
  });
}

// Espelha cada destinatario do broadcast na inbox: garante uma conversa por
// contato e grava a mensagem outbound do template (preview por contato — nome
// resolvido localmente quando o template usa variavel de nome). Sem isso o
// disparo em massa nunca aparece na inbox (so atualizava campaign_contacts).
// Nao pausa a IA nem mexe no status da conversa — apenas registra a mensagem e
// sobe `last_message_at` para reordenar a lista.
async function recordCampaignInbox(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  entries: Array<{ contactId: string; campaignContactId: string; preview: string }>,
  sentAt: string,
): Promise<void> {
  const contactIds = entries.map((e) => e.contactId);
  if (contactIds.length === 0) return;

  // Conversas existentes desses contatos (da org).
  const { data: existing } = await admin
    .from('conversations')
    .select('id, contact_id')
    .eq('org_id', orgId)
    .in('contact_id', contactIds);
  const convByContact = new Map<string, string>();
  for (const row of (existing ?? []) as Array<{ id: string; contact_id: string }>) {
    convByContact.set(row.contact_id, row.id);
  }

  // Cria conversas para contatos ainda sem uma (default 'ai_active').
  const missingContacts = contactIds.filter((id) => !convByContact.has(id));
  if (missingContacts.length > 0) {
    const { data: created } = await admin
      .from('conversations')
      .insert(missingContacts.map((id) => ({ org_id: orgId, contact_id: id, status: 'ai_active', last_message_at: sentAt })))
      .select('id, contact_id');
    for (const row of (created ?? []) as Array<{ id: string; contact_id: string }>) {
      convByContact.set(row.contact_id, row.id);
    }
  }

  // Mensagem outbound (template) por conversa, com o preview daquele contato.
  const messages = entries
    .map((e) => ({
      conversationId: convByContact.get(e.contactId),
      campaignContactId: e.campaignContactId,
      preview: e.preview,
    }))
    .filter(
      (m): m is { conversationId: string; campaignContactId: string; preview: string } =>
        Boolean(m.conversationId),
    )
    .map((m) => ({
      org_id: orgId,
      conversation_id: m.conversationId,
      direction: 'outbound',
      sender_type: 'system',
      content_type: 'template',
      content: m.preview,
      meta_status: 'sent',
      // Vinculo com a linha da campanha: o sync-broadcast-status usa isto para
      // propagar delivered/read/failed (+ motivo) para o espelho da inbox.
      campaign_contact_id: m.campaignContactId,
      is_private_note: false,
    }));
  if (messages.length > 0) {
    await admin.from('messages').insert(messages);
    await admin
      .from('conversations')
      .update({ last_message_at: sentAt })
      .in('id', [...convByContact.values()]);
  }
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

  // 1. Promove scheduled → sending para campanhas cujo horario chegou.
  const nowIso = new Date().toISOString();
  await admin
    .from('campaigns')
    .update({ status: 'sending', started_at: nowIso })
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso);

  // 2. Campanhas em envio.
  const { data: campaigns, error: campErr } = await admin
    .from('campaigns')
    .select('id, org_id, channel_id, name, template_id, status, variable_mapping')
    .eq('status', 'sending');
  if (campErr) return jsonResponse({ ok: false, error: campErr.message }, { status: 500 });

  const rows = (campaigns ?? []) as CampaignRow[];
  if (rows.length === 0) return jsonResponse({ ok: true, processed: 0 });

  // Só orgs ativas — campanhas de orgs arquivadas são puladas (log).
  const orgIds = [...new Set(rows.map((r) => r.org_id))];
  const { data: activeOrgRows } = await admin
    .from('organizations')
    .select('id')
    .eq('status', 'active')
    .in('id', orgIds);
  const activeOrgs = new Set(((activeOrgRows ?? []) as Array<{ id: string }>).map((o) => o.id));

  // Contexto Zernio resolvido POR CANAL da campanha (cache no request). Se a
  // campanha define um canal, usa o accountId dele; senão o default da org.
  const ctxCache = new Map<string, ZernioContext>();
  const resolveCampaignCtx = async (c: CampaignRow): Promise<ZernioContext> => {
    let accountId: string | null = null;
    if (c.channel_id) {
      const channel = await getChannelById(admin, c.channel_id);
      accountId = channel?.zernio_account_id ?? null;
    }
    const cacheKey = `${c.org_id}:${accountId ?? 'default'}`;
    const cached = ctxCache.get(cacheKey);
    if (cached) return cached;
    const ctx = await loadOrgZernioContext(admin, c.org_id, accountId);
    ctxCache.set(cacheKey, ctx);
    return ctx;
  };

  let totalSent = 0;
  let totalFailed = 0;
  const errors: string[] = [];
  const templateCache = new Map<string, TemplateRow | null>();

  async function getTemplate(id: string): Promise<TemplateRow | null> {
    if (templateCache.has(id)) return templateCache.get(id) ?? null;
    const { data: tpl } = await admin
      .from('templates')
      .select('id, name, language, body')
      .eq('id', id)
      .maybeSingle();
    const row = tpl ? (tpl as TemplateRow) : null;
    templateCache.set(id, row);
    return row;
  }

  for (const c of rows) {
    // Org arquivada: pula a campanha inteira.
    if (!activeOrgs.has(c.org_id)) {
      console.log(JSON.stringify({ event: 'dispatch_campaign_skip', reason: 'org_not_active', campaignId: c.id, orgId: c.org_id }));
      continue;
    }

    // Contexto Zernio da campanha (canal da campanha ou default da org).
    let ctx: ZernioContext;
    try {
      ctx = await resolveCampaignCtx(c);
    } catch (err) {
      errors.push(`campaign ${c.id}: ${err instanceof Error ? err.message : 'ctx'}`);
      continue;
    }
    if (!ctx.profileId) {
      errors.push(`campaign ${c.id}: profileId do Zernio ausente (necessario para broadcasts).`);
      continue;
    }

    // Reserva atomica do lote pendente.
    const { data: pending, error: pErr } = await admin.rpc('claim_campaign_contacts', {
      p_campaign_id: c.id,
      p_limit: PER_TICK_LIMIT,
    });
    if (pErr) {
      errors.push(`campaign ${c.id}: ${pErr.message}`);
      continue;
    }
    const queue = (pending ?? []) as CampaignContactRow[];
    if (queue.length === 0) {
      // Nada reservavel: conclui a campanha se nao ha mais nada pendente.
      const { count: pendingLeft } = await admin
        .from('campaign_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id)
        .eq('status', 'pending');
      if ((pendingLeft ?? 0) === 0) {
        await admin
          .from('campaigns')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', c.id);
      }
      continue;
    }

    // Telefone + nome dos contatos do lote (nome alimenta a variavel { field:'name' }).
    const contactIds = queue.map((q) => q.contact_id);
    const { data: contacts } = await admin
      .from('contacts')
      .select('id, phone, name')
      .eq('org_id', c.org_id)
      .in('id', contactIds);
    const phoneById = new Map<string, string>();
    const nameById = new Map<string, string>();
    for (const row of (contacts ?? []) as Array<{ id: string; phone: string; name: string | null }>) {
      phoneById.set(row.id, row.phone);
      if (row.name && row.name.trim() !== '') nameById.set(row.id, row.name.trim());
    }

    // Agrupa por template efetivo.
    const groups = new Map<string, CampaignContactRow[]>();
    for (const q of queue) {
      const tid = q.template_id_override ?? c.template_id;
      const list = groups.get(tid) ?? [];
      list.push(q);
      groups.set(tid, list);
    }

    let campaignSent = 0;
    let campaignFailed = 0;
    let lastBroadcastId: string | null = null;

    for (const [templateId, groupRows] of groups) {
      const template = await getTemplate(templateId);
      const releaseOrFail = async (failMessage: string | null, retryable: boolean, rows: CampaignContactRow[] = groupRows) => {
        // retryable → volta a pending (libera reserva); senao marca failed.
        const ids = rows.map((r) => r.id);
        if (retryable) {
          await admin
            .from('campaign_contacts')
            .update({ status: 'pending', claimed_at: null, error_message: failMessage })
            .in('id', ids);
        } else {
          await admin
            .from('campaign_contacts')
            .update({ status: 'failed', claimed_at: null, error_message: failMessage })
            .in('id', ids);
          campaignFailed += ids.length;
        }
      };

      if (!template) {
        await releaseOrFail('Template nao encontrado', false);
        errors.push(`campaign ${c.id}: template ${templateId} nao encontrado`);
        continue;
      }

      // ---- Caminho DIRETO (1:1) — variaveis de negocio por destinatario ----
      const directVarCount = countVariables(template.body);
      if (usesDealFields(c.variable_mapping, directVarCount)) {
        // Teto menor por tick: devolve o excedente para o proximo tick.
        const batch = groupRows.slice(0, DIRECT_PER_TICK);
        const overflow = groupRows.slice(DIRECT_PER_TICK);
        if (overflow.length > 0) {
          await admin
            .from('campaign_contacts')
            .update({ claimed_at: null })
            .in('id', overflow.map((r) => r.id));
        }

        const batchContactIds = batch.map((r) => r.contact_id);
        const dealByContact = await loadDealData(admin, c.org_id, batchContactIds);
        const { data: convRows } = await admin
          .from('conversations')
          .select('id, contact_id, zernio_conversation_id')
          .eq('org_id', c.org_id)
          .in('contact_id', batchContactIds);
        const convByContact = new Map<string, { id: string; zernio_conversation_id: string | null }>();
        for (const row of (convRows ?? []) as Array<{ id: string; contact_id: string; zernio_conversation_id: string | null }>) {
          convByContact.set(row.contact_id, { id: row.id, zernio_conversation_id: row.zernio_conversation_id });
        }

        await withConcurrency(batch, DIRECT_CONCURRENCY, async (r) => {
          const phone = phoneById.get(r.contact_id);
          if (!phone) {
            await admin
              .from('campaign_contacts')
              .update({ status: 'failed', claimed_at: null, error_message: 'Contato sem telefone' })
              .eq('id', r.id);
            campaignFailed += 1;
            return;
          }

          // Resolve todas as variaveis deste destinatario.
          const params: string[] = [];
          const missingParts: string[] = [];
          const deal = dealByContact.get(r.contact_id);
          for (let i = 1; i <= directVarCount; i++) {
            const { value, missingLabel } = resolveDirectValue(
              c.variable_mapping?.[String(i)],
              nameById.get(r.contact_id) ?? null,
              deal,
            );
            if (value === null) missingParts.push(`{{${i}}}: ${missingLabel}`);
            else params.push(value);
          }
          if (missingParts.length > 0) {
            await admin
              .from('campaign_contacts')
              .update({ status: 'failed', claimed_at: null, error_message: `Variaveis sem valor — ${missingParts.join('; ')}` })
              .eq('id', r.id);
            campaignFailed += 1;
            return;
          }

          try {
            // Conversa 1:1 no Zernio (reusa a conhecida; senao cria pelo telefone).
            const localConv = convByContact.get(r.contact_id);
            let zConvId = localConv?.zernio_conversation_id ?? null;
            if (!zConvId) {
              const created = await createInboxConversation({
                apiKey: ctx.apiKey,
                accountId: ctx.accountId,
                participantId: phone,
              });
              zConvId = created.conversationId;
              if (zConvId && localConv) {
                await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', localConv.id);
              }
            }
            if (!zConvId) throw new Error('não resolveu a conversa no Zernio');

            const sent = await sendInboxTemplate({
              apiKey: ctx.apiKey,
              accountId: ctx.accountId,
              conversationId: zConvId,
              name: template.name,
              language: template.language,
              components: directVarCount > 0
                ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }]
                : [],
            });

            const sentAt = new Date().toISOString();
            await admin
              .from('campaign_contacts')
              .update({
                status: 'sent',
                sent_at: sentAt,
                zernio_message_id: sent.messageId,
                zernio_conversation_id: zConvId,
                error_message: null,
                claimed_at: null,
              })
              .eq('id', r.id);
            campaignSent += 1;

            // Espelho na inbox com o texto real enviado. O status de entrega
            // deste envio chega pelo webhook (message.sent/delivered/failed via
            // zernio_message_id) — nao pelo sync de broadcast.
            let localConvId = localConv?.id ?? null;
            if (!localConvId) {
              const { data: createdConv } = await admin
                .from('conversations')
                .insert({
                  org_id: c.org_id,
                  contact_id: r.contact_id,
                  status: 'ai_active',
                  zernio_conversation_id: zConvId,
                  last_message_at: sentAt,
                })
                .select('id')
                .single();
              localConvId = (createdConv as { id: string } | null)?.id ?? null;
            }
            if (localConvId) {
              const preview = template.body.replace(
                /\{\{\s*(\d+)\s*\}\}/g,
                (_w, n: string) => params[Number(n) - 1] ?? '',
              );
              await admin.from('messages').insert({
                org_id: c.org_id,
                conversation_id: localConvId,
                direction: 'outbound',
                sender_type: 'system',
                content_type: 'template',
                content: preview,
                meta_status: 'sent',
                zernio_message_id: sent.messageId,
                campaign_contact_id: r.id,
                is_private_note: false,
              });
              await admin.from('conversations').update({ last_message_at: sentAt }).eq('id', localConvId);
            }
          } catch (err) {
            const retryable = err instanceof ZernioError && (err.status === 429 || err.status >= 500);
            const msg = err instanceof Error ? err.message : 'Erro no envio';
            await admin
              .from('campaign_contacts')
              .update(
                retryable
                  ? { status: 'pending', claimed_at: null, error_message: `Tentando novamente: ${msg}` }
                  : { status: 'failed', claimed_at: null, error_message: msg },
              )
              .eq('id', r.id);
            if (!retryable) campaignFailed += 1;
          }
        });
        continue;
      }
      // ---- Caminho BROADCAST (nome / valor fixo) --------------------------

      const { components, variableMapping, missing, needsName, nameFallback } =
        buildBroadcastComponents(template, c.variable_mapping);
      if (missing.length > 0) {
        // Guarda defensiva: nunca disparar com variavel em branco. Marca a linha
        // failed com motivo legivel em vez de virar "sent" e a mensagem sumir.
        const msg = `Variaveis sem valor: ${missing.map((i) => `{{${i}}}`).join(', ')}. Em campanhas, cada variavel precisa de um valor fixo ou do nome do contato.`;
        await releaseOrFail(msg, false);
        errors.push(`campaign ${c.id}: ${msg}`);
        continue;
      }

      // Linhas enviaveis: precisam de telefone e — quando o template usa a
      // variavel de nome — de nome no contato (senao o Zernio resolveria o
      // placeholder vazio e a Meta rejeitaria a mensagem em silencio). Se a
      // variavel tem fallback, contatos sem nome usam o fallback como nome
      // efetivo (importado no Zernio abaixo) em vez de falhar.
      const effectiveNameById = new Map<string, string>();
      const sendable: CampaignContactRow[] = [];
      const noPhone: CampaignContactRow[] = [];
      const noName: CampaignContactRow[] = [];
      for (const r of groupRows) {
        const name = nameById.get(r.contact_id) ?? nameFallback;
        if (!phoneById.get(r.contact_id)) {
          noPhone.push(r);
        } else if (needsName && !name) {
          noName.push(r);
        } else {
          if (name) effectiveNameById.set(r.contact_id, name);
          sendable.push(r);
        }
      }
      if (noPhone.length > 0) {
        await admin
          .from('campaign_contacts')
          .update({ status: 'failed', claimed_at: null, error_message: 'Contato sem telefone' })
          .in('id', noPhone.map((r) => r.id));
        campaignFailed += noPhone.length;
      }
      if (noName.length > 0) {
        await admin
          .from('campaign_contacts')
          .update({ status: 'failed', claimed_at: null, error_message: 'Contato sem nome e a campanha nao definiu fallback (o template usa a variavel Nome do contato)' })
          .in('id', noName.map((r) => r.id));
        campaignFailed += noName.length;
      }
      if (sendable.length === 0) continue;
      const phones = sendable.map((r) => phoneById.get(r.contact_id) as string);

      try {
        // Com variavel de nome: importa os contatos no Zernio ANTES dos
        // recipients, para que os auto-criados ja tenham nome (o Zernio resolve
        // { field:'name' } a partir do contato dele, nao do nosso banco).
        if (needsName) {
          const withNames = sendable.map((r) => ({
            name: effectiveNameById.get(r.contact_id) as string,
            platformIdentifier: phoneById.get(r.contact_id) as string,
          }));
          for (const part of chunk(withNames, 1000)) {
            await bulkCreateContacts({
              apiKey: ctx.apiKey,
              profileId: ctx.profileId,
              accountId: ctx.accountId,
              contacts: part,
            });
          }
        }

        const broadcastId = await createBroadcast({
          apiKey: ctx.apiKey,
          profileId: ctx.profileId,
          accountId: ctx.accountId,
          name: `${c.name} · ${template.name}`,
          template: {
            name: template.name,
            language: template.language,
            components,
            ...(Object.keys(variableMapping).length > 0 ? { variableMapping } : {}),
          },
        });
        for (const part of chunk(phones, RECIPIENTS_CHUNK)) {
          await addBroadcastRecipients({ apiKey: ctx.apiKey, broadcastId, phones: part });
        }
        await sendBroadcast({ apiKey: ctx.apiKey, broadcastId });

        const sentAt = new Date().toISOString();
        await admin
          .from('campaign_contacts')
          .update({ status: 'sent', sent_at: sentAt, zernio_broadcast_id: broadcastId, error_message: null, claimed_at: null })
          .in('id', sendable.map((r) => r.id));
        campaignSent += sendable.length;
        lastBroadcastId = broadcastId;

        // Espelha o disparo na inbox (apenas contatos efetivamente no broadcast).
        // Falha aqui nao deve reverter o envio.
        try {
          const entries = sendable.map((r) => ({
            contactId: r.contact_id,
            campaignContactId: r.id,
            preview: renderTemplatePreview(template.body, c.variable_mapping, effectiveNameById.get(r.contact_id) ?? null),
          }));
          await recordCampaignInbox(admin, c.org_id, entries, sentAt);
        } catch (inboxErr) {
          errors.push(`campaign ${c.id}: inbox mirror: ${inboxErr instanceof Error ? inboxErr.message : 'erro'}`);
        }
      } catch (err) {
        const retryable = err instanceof ZernioError && (err.status === 429 || err.status >= 500);
        const msg = err instanceof Error ? err.message : 'Erro no broadcast';
        // So as linhas enviaveis: as sem telefone/nome ja foram marcadas failed.
        await releaseOrFail(retryable ? `Tentando novamente: ${msg}` : msg, retryable, sendable);
        errors.push(`campaign ${c.id}: broadcast: ${msg}`);
      }
    }

    if (campaignSent > 0) {
      await admin.rpc('bump_campaign_counter', { p_campaign_id: c.id, p_column: 'sent', p_delta: campaignSent });
    }
    if (campaignFailed > 0) {
      await admin.rpc('bump_campaign_counter', { p_campaign_id: c.id, p_column: 'failed', p_delta: campaignFailed });
    }
    if (lastBroadcastId) {
      await admin.from('campaigns').update({ zernio_broadcast_id: lastBroadcastId }).eq('id', c.id);
    }

    totalSent += campaignSent;
    totalFailed += campaignFailed;
  }

  return jsonResponse({ ok: true, campaigns: rows.length, sent: totalSent, failed: totalFailed, errors });
});
