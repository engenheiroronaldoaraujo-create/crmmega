// Admin gate compartilhado pelas Vercel API Routes (api/credentials,
// api/zernio-connect). Esses endpoints rodam com a service role, entao sem esse
// check qualquer um poderia ler/escrever o cofre de credenciais. O owner criado
// no /setup carrega app_metadata.role = 'admin' (espelhado no JWT).

import { createClient } from '@supabase/supabase-js';

export type AdminAuthResult =
  | { ok: true; userId: string; orgId: string; isSuperAdmin: boolean }
  | { ok: false; status: number; message: string };

export type SuperAdminAuthResult =
  | { ok: true; userId: string; orgId: string | null; homeOrgId: string | null }
  | { ok: false; status: number; message: string };

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function requireAdmin(
  authHeader: string | string[] | undefined,
): Promise<AdminAuthResult> {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, message: 'Sessao ausente.' };

  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, message: 'Sessao invalida ou expirada.' };
  }
  const meta = (data.user.app_metadata ?? {}) as {
    role?: string;
    org_id?: string;
    is_super_admin?: boolean;
  };
  if (meta.role !== 'admin') {
    return { ok: false, status: 403, message: 'Acesso restrito a administradores.' };
  }
  if (!meta.org_id) {
    return { ok: false, status: 403, message: 'Sessao sem organizacao. Faca login novamente.' };
  }
  return {
    ok: true,
    userId: data.user.id,
    orgId: meta.org_id,
    isSuperAdmin: meta.is_super_admin === true,
  };
}

// Gate do console /admin: exige a claim is_super_admin no JWT.
export async function requireSuperAdmin(
  authHeader: string | string[] | undefined,
): Promise<SuperAdminAuthResult> {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, message: 'Sessao ausente.' };

  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, message: 'Sessao invalida ou expirada.' };
  }
  const meta = (data.user.app_metadata ?? {}) as {
    org_id?: string;
    home_org_id?: string;
    is_super_admin?: boolean;
  };
  if (meta.is_super_admin !== true) {
    return { ok: false, status: 403, message: 'Acesso restrito ao super admin.' };
  }
  return {
    ok: true,
    userId: data.user.id,
    orgId: meta.org_id ?? null,
    homeOrgId: meta.home_org_id ?? null,
  };
}
