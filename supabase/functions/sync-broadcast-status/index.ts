// ============================================================================
// sync-broadcast-status  (cron target, 2min)
// ----------------------------------------------------------------------------
// Reconciliacao de entrega dos disparos em massa. O webhook do Zernio entrega
// eventos de status SEM o broadcastId, entao delivered/read/failed por
// destinatario de campanha nunca eram aplicados em campaign_contacts (a linha
// ficava 'sent' para sempre e uma falha sumia silenciosamente).
//
// Por tick: pega os broadcasts recentes com linhas ainda nao-terminais
// (sent/delivered), consulta GET /broadcasts/{id}/recipients no Zernio, e
// avanca cada linha (delivered/read) ou a marca failed com o motivo. Correlaciona
// destinatario ↔ linha por telefone (digits-only). Atualiza os contadores
// agregados da campanha.
//
// Complementa o zernio-webhook (que so reconcilia mensagens 1:1 e o 'replied'
// inbound); nao o substitui.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { getBroadcastRecipients, type ZernioContext } from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';

// Quantos broadcasts distintos reconciliar por tick (cada um = 1 GET no Zernio).
const BROADCAST_LIMIT = 25;
// Nao pollar broadcasts antigos para sempre: linhas paradas ha mais de N dias
// dificilmente mudam de status.
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

// Funil de entrega; usado para so avancar (nunca regredir read→delivered).
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

interface ContactRow {
  id: string;
  campaign_id: string;
  status: 'sent' | 'delivered';
  delivered_at: string | null;
  contacts: { phone: string | null } | { phone: string | null }[] | null;
}

function onlyDigits(p: string): string {
  return p.replace(/\D/g, '');
}

// Normaliza o status cru do Zernio para o enum de campaign_contacts.
function mapStatus(raw: string | null): 'delivered' | 'read' | 'failed' | 'sent' | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('read')) return 'read';
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('fail') || s.includes('undeliver') || s.includes('reject') || s.includes('error')) {
    return 'failed';
  }
  if (s.includes('sent') || s.includes('accept') || s.includes('queue') || s.includes('pending') || s.includes('process')) {
    return 'sent';
  }
  return null;
}

function contactPhone(row: ContactRow): string | null {
  const c = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
  return c?.phone ?? null;
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

  // Broadcasts recentes com linhas ainda nao-terminais (com o org_id de cada
  // linha para reconciliar com o contexto Zernio da org dona da campanha).
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data: bidRows, error: bidErr } = await admin
    .from('campaign_contacts')
    .select('zernio_broadcast_id, org_id')
    .not('zernio_broadcast_id', 'is', null)
    .in('status', ['sent', 'delivered'])
    .gte('sent_at', cutoff)
    .limit(5000);
  if (bidErr) return jsonResponse({ ok: false, error: bidErr.message }, { status: 500 });

  // broadcastId → org_id (1:1 — um broadcast pertence a uma campanha/org).
  const orgByBroadcast = new Map<string, string>();
  for (const r of (bidRows ?? []) as Array<{ zernio_broadcast_id: string; org_id: string }>) {
    if (!orgByBroadcast.has(r.zernio_broadcast_id)) {
      orgByBroadcast.set(r.zernio_broadcast_id, r.org_id);
    }
  }
  const broadcastIds = [...orgByBroadcast.keys()].slice(0, BROADCAST_LIMIT);
  if (broadcastIds.length === 0) return jsonResponse({ ok: true, broadcasts: 0, updated: 0 });

  // Só orgs ativas (arquivadas: pula os broadcasts delas).
  const orgIds = [...new Set(broadcastIds.map((id) => orgByBroadcast.get(id) as string))];
  const { data: activeOrgRows } = await admin
    .from('organizations')
    .select('id')
    .eq('status', 'active')
    .in('id', orgIds);
  const activeOrgs = new Set(((activeOrgRows ?? []) as Array<{ id: string }>).map((o) => o.id));

  // Contexto Zernio resolvido por org (cache no request).
  const ctxByOrg = new Map<string, ZernioContext>();
  const loadCtx = async (orgId: string): Promise<ZernioContext | null> => {
    const cached = ctxByOrg.get(orgId);
    if (cached) return cached;
    try {
      const ctx = await loadOrgZernioContext(admin, orgId);
      ctxByOrg.set(orgId, ctx);
      return ctx;
    } catch {
      return null;
    }
  };

  let updated = 0;
  const errors: string[] = [];

  const bumpCounter = async (campaignId: string, column: string) => {
    const { error } = await admin.rpc('bump_campaign_counter', {
      p_campaign_id: campaignId,
      p_column: column,
      p_delta: 1,
    });
    if (error) errors.push(`counter ${column}: ${error.message}`);
  };

  for (const broadcastId of broadcastIds) {
    const orgId = orgByBroadcast.get(broadcastId) as string;
    if (!activeOrgs.has(orgId)) {
      console.log(JSON.stringify({ event: 'sync_broadcast_status_skip', reason: 'org_not_active', broadcastId, orgId }));
      continue;
    }
    const ctx = await loadCtx(orgId);
    if (!ctx) {
      errors.push(`broadcast ${broadcastId}: sem contexto Zernio da org ${orgId}`);
      continue;
    }
    let recipients;
    try {
      recipients = await getBroadcastRecipients(ctx.apiKey, broadcastId);
    } catch (err) {
      // Transitorio ou shape inesperado — segue para o proximo, retenta no proximo tick.
      errors.push(`broadcast ${broadcastId}: ${err instanceof Error ? err.message : 'erro'}`);
      continue;
    }
    if (recipients.length === 0) continue;

    // Indexa o status cru do Zernio por telefone (digits-only).
    const byPhone = new Map<string, (typeof recipients)[number]>();
    for (const r of recipients) {
      if (r.phone) byPhone.set(onlyDigits(r.phone), r);
    }

    const { data: rows, error: rowsErr } = await admin
      .from('campaign_contacts')
      .select('id, campaign_id, status, delivered_at, contacts(phone)')
      .eq('zernio_broadcast_id', broadcastId)
      .in('status', ['sent', 'delivered']);
    if (rowsErr) {
      errors.push(`rows ${broadcastId}: ${rowsErr.message}`);
      continue;
    }

    for (const row of (rows ?? []) as ContactRow[]) {
      const phone = contactPhone(row);
      if (!phone) continue;
      const rec = byPhone.get(onlyDigits(phone));
      if (!rec) continue;

      const next = mapStatus(rec.status);
      if (!next || next === 'sent') continue;

      const nowIso = new Date().toISOString();

      if (next === 'failed') {
        const reason = rec.error ?? 'Broadcast recipient failed';
        const { error } = await admin
          .from('campaign_contacts')
          .update({ status: 'failed', error_message: reason })
          .eq('id', row.id);
        if (error) {
          errors.push(`update ${row.id}: ${error.message}`);
          continue;
        }
        // Propaga para o espelho da inbox: sem isto a mensagem ficava "sent"
        // para sempre e o operador nunca via a falha nem o motivo.
        await admin
          .from('messages')
          .update({ meta_status: 'failed', error_reason: reason })
          .eq('campaign_contact_id', row.id);
        await bumpCounter(row.campaign_id, 'failed');
        updated++;
        continue;
      }

      // delivered | read — so avanca (funil monotonico).
      if ((STATUS_RANK[next] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) continue;

      const patch: Record<string, unknown> = { status: next };
      if (next === 'delivered') patch.delivered_at = nowIso;
      if (next === 'read') {
        patch.read_at = nowIso;
        if (!row.delivered_at) patch.delivered_at = nowIso;
      }
      const { error } = await admin.from('campaign_contacts').update(patch).eq('id', row.id);
      if (error) {
        errors.push(`update ${row.id}: ${error.message}`);
        continue;
      }
      // Espelho da inbox acompanha o funil (o guard de rank acima garante que
      // nunca regride read→delivered).
      await admin
        .from('messages')
        .update({ meta_status: next })
        .eq('campaign_contact_id', row.id);
      await bumpCounter(row.campaign_id, next);
      // Se pulou direto sent→read, conta tambem o delivered para o funil fechar.
      if (next === 'read' && row.status === 'sent') await bumpCounter(row.campaign_id, 'delivered');
      updated++;
    }
  }

  console.log(JSON.stringify({ event: 'sync_broadcast_status', broadcasts: broadcastIds.length, updated, errorCount: errors.length }));
  return jsonResponse({ ok: true, broadcasts: broadcastIds.length, updated, errors: errors.slice(0, 20) });
});
