// ============================================================================
// sync-template-status
// ----------------------------------------------------------------------------
// Sincroniza o status dos templates direto da Meta (via Zernio
// GET /whatsapp/templates), como fallback ao webhook
// whatsapp.template.status_updated. Útil quando o webhook atrasa ou falha.
// Admin-only, acionado por um botão na tela de Templates.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { ZernioError, listTemplates, type ZernioTemplate } from '../_shared/zernio.ts';
import { listActiveChannels, loadOrgZernioContext } from '../_shared/channels.ts';

function mapStatus(meta: string | null): 'approved' | 'rejected' | 'pending' {
  const s = (meta ?? '').toUpperCase();
  if (s === 'APPROVED') return 'approved';
  if (['REJECTED', 'DISABLED', 'PAUSED'].includes(s)) return 'rejected';
  return 'pending';
}

// Converte variáveis nomeadas da Meta ({{nome}}, {{produto}}) para
// numeradas ({{1}}, {{2}}) — o sistema interno usa numeração.
function normalizeBodyVariables(body: string): string {
  const seen = new Map<string, string>();
  let counter = 1;
  return body.replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (_match, varName: string) => {
    if (!seen.has(varName)) {
      seen.set(varName, `{{${counter}}}`);
      counter++;
    }
    return seen.get(varName)!;
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);
    const orgId = caller.orgId;
    const admin = getAdminClient();
    let ctx;
    try {
      ctx = await loadOrgZernioContext(admin, orgId);
    } catch (err) {
      return jsonResponse({ ok: false, error: `Zernio context: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
    }

    // Lista os templates da Meta por canal Zernio da org (accountId de cada
    // número conectado + o default da org como fallback). O status é o mesmo
    // por WABA, mas números distintos podem ter templates distintos.
    const zernioChannels = await listActiveChannels(admin, orgId, 'zernio');
    const accountIds = [
      ...new Set(
        [ctx.accountId, ...zernioChannels.map((ch) => ch.zernio_account_id)]
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const byName = new Map<string, ZernioTemplate>();
    const fetchErrors: string[] = [];
    for (const accountId of accountIds) {
      try {
        const remote = await listTemplates(ctx.apiKey, accountId);
        for (const t of remote) {
          if (t.name) byName.set(t.name, t);
        }
      } catch (err) {
        fetchErrors.push(`account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Só os templates que já foram submetidos (têm submitted_at) e ainda não
    // estão num estado terminal definitivo precisam de sync; mas sincronizamos
    // todos que casam por nome para refletir mudanças (ex.: pausados). Só os
    // templates DA ORG do caller.
    const { data: locals, error } = await admin
      .from('templates')
      .select('id, name, status, body, variables')
      .eq('org_id', orgId);
    if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 });

    let updated = 0;
    let approved = 0;
    let rejected = 0;
    for (const local of (locals ?? []) as Array<{ id: string; name: string; status: string }>) {
      const r = byName.get(local.name);
      if (!r) continue;
      const mapped = mapStatus(r.status);
      const patch: Record<string, unknown> = {
        status: mapped,
        meta_template_status: r.status ?? null,
      };
      if (r.id) patch.meta_template_id = r.id;
      if (mapped === 'approved') {
        patch.approved_at = new Date().toISOString();
        approved++;
      } else if (mapped === 'rejected') {
        rejected++;
      }
      // Evita escrita redundante quando nada mudou.
      if (local.status !== mapped || r.id) {
        await admin.from('templates').update(patch).eq('id', local.id);
        updated++;
      }
    }

    // Importa templates da Meta que não existem localmente, e preenche o body
    // dos que existem mas estão vazios (import anterior sem dados completos).
    const localNames = new Set((locals ?? []).map((l) => l.name));
    let imported = 0;
    let patched = 0;
    for (const [name, remote] of byName) {
      const mapped = mapStatus(remote.status);
      const nowIso = new Date().toISOString();
      if (localNames.has(name)) {
        const local = (locals ?? []).find((l) => l.name === name);
        if (local && remote.body) {
          const hasNamedVars = /\{\{\s*[a-zA-Z_]\w*\s*\}\}/.test(local.body) && !/\{\{\s*\d+\s*\}\}/.test(local.body);
          const wantVars = Object.keys(remote.paramNames).length > 0 ? remote.paramNames : {};
          const localVars = (local.variables ?? {}) as Record<string, string>;
          const varsDiffer = JSON.stringify(wantVars) !== JSON.stringify(localVars);
          if (!local.body || hasNamedVars || varsDiffer) {
            const normalized = hasNamedVars || !local.body ? normalizeBodyVariables(remote.body) : local.body;
            const patch: Record<string, unknown> = {};
            if (normalized !== local.body) patch.body = normalized;
            if (remote.category) patch.category = remote.category.toLowerCase();
            if (remote.language) patch.language = remote.language;
            if (remote.headerType) patch.header_type = remote.headerType === 'TEXT' ? 'text' : remote.headerType === 'IMAGE' ? 'image' : remote.headerType === 'VIDEO' ? 'video' : 'none';
            patch.variables = wantVars;
            await admin.from('templates').update(patch).eq('id', local.id);
            patched++;
          }
        }
        continue;
      }
      const { error: insErr } = await admin.from('templates').insert({
        org_id: orgId,
        name,
        category: (remote.category ?? 'marketing').toLowerCase(),
        language: remote.language ?? 'pt_BR',
        status: mapped,
        meta_template_id: remote.id ?? null,
        meta_template_status: remote.status ?? null,
        body: remote.body ? normalizeBodyVariables(remote.body) : '',
        header_type: remote.headerType === 'TEXT' ? 'text' : remote.headerType === 'IMAGE' ? 'image' : remote.headerType === 'VIDEO' ? 'video' : 'none',
        buttons: '[]',
        variables: Object.keys(remote.paramNames).length > 0 ? remote.paramNames : {},
        ...(mapped === 'approved' ? { approved_at: nowIso } : {}),
      });
      if (!insErr) imported++;
    }

    return jsonResponse({ ok: true, checked: byName.size, updated, approved, rejected, imported, patched, fetchErrors });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    if (err instanceof ZernioError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status === 401 ? 401 : 502 });
    }
    console.error('sync-template-status error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
