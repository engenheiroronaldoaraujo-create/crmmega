// repair-names — repara nomes placeholder de contatos no Zernio.
//
// Contatos auto-criados pelo Zernio (webhook/broadcast) nascem SEM nome (a
// resposta da API mostra o telefone como fallback). O POST /contacts/bulk
// pula duplicados e não atualiza existentes — o broadcast com variável
// { field: 'name' } falha com "Parameter name is missing or empty".
//
// Este job: lista os contatos do Zernio (paginado), cruza com a base local
// (whatsapp_hub.contacts por telefone digits-only) e faz PATCH nos que têm
// nome placeholder. Limite por invocação (PATCH_BUDGET) para caber no
// wall-clock da Edge Function — chame de novo até remaining=0.
//
// Admin-only (JWT) ou service role (cron/manual).
import { requireAdmin } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  isPhoneLikeName,
  mapZernioContactsByPhone,
  updateZernioContact,
  type ZernioContactRef,
} from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';

// PATCHes por invocação (cada um ~300ms; 50 ≈ 15s + listing ~10s).
const PATCH_BUDGET = 50;

function normalizeDigits(p: string): string {
  return p.replace(/\D/g, '');
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  let orgId: string | null = null;
  try {
    const caller = await requireAdmin(req);
    orgId = caller.orgId;
  } catch {
    // Fallback: service role (invocação manual/cron) + org_id na query.
    try {
      const { requireServiceRole } = await import('../_shared/auth.ts');
      await requireServiceRole(req);
      orgId = new URL(req.url).searchParams.get('org_id');
    } catch {
      return jsonResponse({ ok: false, error: 'Não autenticado' }, { status: 401 });
    }
  }
  if (!orgId) return jsonResponse({ ok: false, error: 'org_id ausente' }, { status: 400 });

  const admin = getAdminClient();
  const org = orgId as string;

  try {
    const ctx = await loadOrgZernioContext(admin, org);

    // 1. Lista todos os contatos do Zernio (paginado).
    const zernioContacts = await mapZernioContactsByPhone({ apiKey: ctx.apiKey, maxPages: 40 });

    // 2. Nomes locais por telefone (digits-only).
    const { data: locals } = await admin
      .from('contacts')
      .select('phone, name')
      .eq('org_id', org);
    const localNameByPhone = new Map<string, string>();
    for (const row of (locals ?? []) as Array<{ phone: string; name: string | null }>) {
      if (row.name && row.name.trim() !== '') localNameByPhone.set(normalizeDigits(row.phone), row.name.trim());
    }

    // 3. Candidatos: contato Zernio com nome placeholder E nome local disponível.
    const candidates: Array<{ ref: ZernioContactRef; name: string }> = [];
    for (const [digits, ref] of zernioContacts) {
      const localName = localNameByPhone.get(digits);
      if (!localName) continue;
      if (isPhoneLikeName(ref.name, digits)) {
        candidates.push({ ref, name: localName });
      }
    }

    const totalCandidates = candidates.length;
    const batch = candidates.slice(0, PATCH_BUDGET);
    let repaired = 0;
    const errors: string[] = [];
    for (const c of batch) {
      try {
        await updateZernioContact({ apiKey: ctx.apiKey, contactId: c.ref.id, name: c.name });
        repaired++;
      } catch (err) {
        errors.push(`${c.ref.platformIdentifier}: ${err instanceof Error ? err.message : 'erro'}`);
      }
      // Pausa entre PATCHes: a Meta aplica rate limit por rajada.
      await new Promise((r) => setTimeout(r, 1200));
    }

    return jsonResponse({
      ok: true,
      zernioContacts: zernioContacts.size,
      localContacts: localNameByPhone.size,
      candidates: totalCandidates,
      repaired,
      remaining: Math.max(0, totalCandidates - repaired),
      errors: errors.slice(0, 10),
      note: repaired < totalCandidates ? 'Chame novamente até remaining=0' : 'Reparação completa',
    });
  } catch (err) {
    console.error('repair-names error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
