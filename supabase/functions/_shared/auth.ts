// Resolve the caller's identity from the Authorization header. We let
// Supabase's auth.getUser() do the JWT signature + expiry verification so we
// don't need to ship the JWT secret into the Edge Function.
//
// Multi-tenant: as claims que importam são `role`, `org_id` e
// `is_super_admin` (espelhadas pelo trigger handle_new_user). Edge Functions
// rodam com service_role e bypassam RLS, então TODO acesso a dados a partir de
// um caller precisa cross-checar o org_id da linha alvo contra caller.orgId.

import { getAdminClient, getAuthAdminClient } from './supabase-admin.ts';

export interface Caller {
  userId: string;
  email: string | null;
  role: 'admin' | 'operator' | null;
  orgId: string | null;
  isSuperAdmin: boolean;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export async function requireCaller(req: Request): Promise<Caller> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new AuthError('Missing Authorization header');
  }

  const admin = getAuthAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    throw new AuthError('Invalid token');
  }

  const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  const role = typeof appMeta.role === 'string' ? appMeta.role : null;
  const orgId = typeof appMeta.org_id === 'string' && appMeta.org_id !== ''
    ? appMeta.org_id
    : null;

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    role: (role as Caller['role']) ?? null,
    orgId,
    isSuperAdmin: appMeta.is_super_admin === true,
  };
}

// Igual a requireCaller, mas exige org no token — o caso normal de qualquer
// função chamada por usuário logado. Sem org = sessão pré-migração (forçar
// re-login) ou token adulterado.
export async function requireOrgCaller(
  req: Request,
): Promise<Caller & { orgId: string }> {
  const caller = await requireCaller(req);
  if (!caller.orgId) {
    throw new AuthError('Sessão sem organização. Faça login novamente.', 403);
  }
  return caller as Caller & { orgId: string };
}

export async function requireAdmin(req: Request): Promise<Caller & { orgId: string }> {
  const caller = await requireOrgCaller(req);
  if (caller.role !== 'admin') {
    throw new AuthError('Admin role required', 403);
  }
  return caller;
}

export async function requireSuperAdmin(req: Request): Promise<Caller> {
  const caller = await requireCaller(req);
  if (!caller.isSuperAdmin) {
    throw new AuthError('Super admin required', 403);
  }
  return caller;
}

// Gate para funções acionadas por pg_cron / triggers pg_net, que NÃO carregam
// um JWT de usuário — elas se autenticam com a service role key (seedada nas
// Vault entries `whatsapp_hub_service_role_key`).
//
// Aceita o token se ele bater com (a) o SUPABASE_SERVICE_ROLE_KEY injetado na
// função OU (b) o segredo da Vault usado pelo cron — validado server-side pela
// RPC verify_service_token. O fallback existe porque o valor da Vault (definido
// no setup) pode divergir do SUPABASE_SERVICE_ROLE_KEY injetado quando o projeto
// usa o novo formato de API keys; sem isso, todo invoke pg_net dá 403.
export async function requireServiceRole(req: Request): Promise<void> {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new AuthError('Forbidden', 403);
  if (expected && constantTimeEqual(token, expected)) return;
  try {
    const { data, error } = await getAdminClient().rpc('verify_service_token', { p_token: token });
    if (!error && data === true) return;
  } catch {
    // cai no throw abaixo
  }
  throw new AuthError('Forbidden', 403);
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
