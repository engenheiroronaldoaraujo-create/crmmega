// ============================================================================
// invite-team-member
// ----------------------------------------------------------------------------
// Admin sends an email + role. We relay to Supabase Auth's inviteUserByEmail,
// encoding the target role into user_metadata. The `handle_new_user` trigger
// reads `invited_role` and provisions the new user accordingly.
//
// Self-hosted single-org build: there is no tenant to attach to. The role
// alone is what the trigger needs.
//
// Only `admin` callers may invite. Email is normalized to lowercase.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAuthAdminClient } from '../_shared/supabase-admin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

type Role = 'admin' | 'operator';

const ROLES = new Set<Role>(['admin', 'operator']);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: { email?: string; role?: Role; app_url?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    const email = (body.email ?? '').trim().toLowerCase();
    const role = body.role as Role | undefined;

    // Regex mais estrita: bloqueia HTML/JS na parte local e exige TLD com 2+ chars.
    if (!email || email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      return jsonResponse({ ok: false, error: 'E-mail inválido.' }, { status: 400 });
    }
    if (!role || !ROLES.has(role)) {
      return jsonResponse({ ok: false, error: 'role inválido.' }, { status: 400 });
    }

    const admin = getAuthAdminClient();

    // redirectTo aponta o link do e-mail de convite (gerado pelo Supabase) para
    // a tela /invite, onde o convidado define a senha. Prioridade:
    //   1. credencial `app_url` (URL de produção registrada no setup);
    //   2. `app_url` enviado pelo frontend (window.location.origin) — garante
    //      que o link vá para o domínio real onde o app está rodando (Vercel),
    //      nunca localhost, mesmo sem a credencial configurada;
    //   3. sem nada válido: cai no Site URL do projeto Supabase.
    const isValidAppUrl = (u: string) => /^https:\/\/[^\s/]+\.[^\s/]+/.test(u);
    const credUrl = (await getCredential(caller.orgId, 'app_url'))?.replace(/\/$/, '') || '';
    const bodyUrl = (body.app_url ?? '').trim().replace(/\/$/, '');
    const appUrl = credUrl || (isValidAppUrl(bodyUrl) ? bodyUrl : '');
    const redirectTo = appUrl ? `${appUrl}/invite` : undefined;

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: {
        invited_role: role,
        // O trigger handle_new_user EXIGE invited_org_id para vincular o novo
        // usuário à organização de quem convidou.
        invited_org_id: caller.orgId,
        invited_by: caller.email,
      },
      ...(redirectTo ? { redirectTo } : {}),
    });

    if (error) {
      // Traduz mensagens comuns do gotrue (que vêm em inglês) pra manter a UI
      // consistente em pt-BR. Caímos no fallback do error.message original
      // quando a mensagem não bate com nenhum padrão conhecido.
      const raw = error.message ?? '';
      let userMessage = raw;
      if (/invalid email|invalid format|Email address.*invalid/i.test(raw)) {
        userMessage = 'E-mail inválido ou domínio não suportado pelo provedor de auth.';
      } else if (/already.*registered|User already registered/i.test(raw)) {
        userMessage = 'Já existe um usuário com esse e-mail.';
      } else if (/rate limit/i.test(raw)) {
        userMessage = 'Muitos convites em sequência. Aguarde alguns minutos e tente de novo.';
      }
      return jsonResponse(
        { ok: false, error: userMessage },
        { status: error.status ?? 400 },
      );
    }

    return jsonResponse({
      ok: true,
      user_id: data.user?.id ?? null,
      email,
      role,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('invite-team-member error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
