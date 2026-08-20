// ============================================================================
// test-zernio-connection
// ----------------------------------------------------------------------------
// Sanity check da conexao com o Zernio. Le a ZERNIO_API_KEY + accountId do
// cofre e chama GET /whatsapp/number-info, devolvendo o numero conectado, o
// tier e a qualidade. Util logo apos o /setup ou na tela de Configuracoes.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { ZernioError, getNumberInfo } from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    const ctx = await loadOrgZernioContext(getAdminClient(), caller.orgId);
    const info = await getNumberInfo(ctx.apiKey, ctx.accountId);

    return jsonResponse(
      {
        ok: true,
        accountId: ctx.accountId,
        number: {
          display_phone_number: info.display_phone_number,
          verified_name: info.verified_name,
          messaging_limit_tier: info.messaging_limit_tier,
          quality_rating: info.quality_rating,
          health_status: info.health_status,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    if (err instanceof ZernioError) {
      return jsonResponse({ ok: false, error: err.message }, { status: 200 });
    }
    console.error('test-zernio-connection error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
