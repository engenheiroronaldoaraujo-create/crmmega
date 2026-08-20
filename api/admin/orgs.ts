import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '../../src/lib/admin-auth.js';

// ============================================================================
// api/admin/orgs
// ----------------------------------------------------------------------------
// Console do SUPER ADMIN (rota /admin). Todas as operações exigem a claim
// is_super_admin no JWT. Roda com service role — as policies RLS já permitem
// ao super admin ler/escrever organizations, mas aqui o gate é feito por
// requireSuperAdmin() e o service role client ignora RLS de qualquer forma.
//
//  GET   → lista orgs com contagem de membros.
//  POST  → cria org (+ seed_org_defaults, + convite opcional do admin inicial).
//  PATCH → renomeia / arquiva / reativa.
// ============================================================================

type ApiRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  created_at: string;
}

async function listOrgs(supabase: SupabaseClient) {
  const { data: orgs, error } = await supabase
    .schema('whatsapp_hub')
    .from('organizations')
    .select('id, name, slug, status, created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  // Contagem de membros por org via uma única leitura de app_users.
  const { data: members, error: membersError } = await supabase
    .schema('whatsapp_hub')
    .from('app_users')
    .select('org_id');
  if (membersError) throw new Error(membersError.message);

  const countByOrg = new Map<string, number>();
  for (const row of (members ?? []) as { org_id: string | null }[]) {
    if (!row.org_id) continue;
    countByOrg.set(row.org_id, (countByOrg.get(row.org_id) ?? 0) + 1);
  }

  return ((orgs ?? []) as OrgRow[]).map((org) => ({
    ...org,
    members: countByOrg.get(org.id) ?? 0,
  }));
}

function readString(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const method = req.method ?? 'GET';
    if (!['GET', 'POST', 'PATCH'].includes(method)) return res.status(405).end();

    const auth = await requireSuperAdmin(
      req.headers?.authorization ?? req.headers?.Authorization,
    );
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    const supabase = getSupabaseAdmin();

    if (method === 'GET') {
      const orgs = await listOrgs(supabase);
      return res.status(200).json({ success: true, orgs });
    }

    if (method === 'POST') {
      const name = readString(req.body, 'name');
      const slug = readString(req.body, 'slug').toLowerCase();
      const adminEmail = readString(req.body, 'adminEmail');

      if (!name) {
        return res.status(400).json({ success: false, message: 'Informe o nome da organização.' });
      }
      if (!SLUG_RE.test(slug)) {
        return res.status(400).json({
          success: false,
          message: 'Slug inválido. Use 2 a 40 caracteres: letras minúsculas, números e hífen.',
        });
      }

      const { data: existing, error: slugError } = await supabase
        .schema('whatsapp_hub')
        .from('organizations')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (slugError) throw new Error(slugError.message);
      if (existing) {
        return res.status(409).json({ success: false, message: 'Já existe uma organização com esse slug.' });
      }

      const { data: created, error: createError } = await supabase
        .schema('whatsapp_hub')
        .from('organizations')
        .insert({ name, slug, status: 'active' })
        .select('id, name, slug, status, created_at')
        .single();
      if (createError) throw new Error(createError.message);

      const org = created as OrgRow;

      // Semeia as linhas de settings padrão da org nova (service role).
      const { error: seedError } = await supabase
        .schema('whatsapp_hub')
        .rpc('seed_org_defaults', { p_org: org.id });
      if (seedError) throw new Error(seedError.message);

      // Convite do admin inicial é best-effort — falha não desfaz a criação.
      let warning: string | undefined;
      if (adminEmail) {
        const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(adminEmail, {
          data: { invited_role: 'admin', invited_org_id: org.id },
        });
        if (inviteError) {
          warning = `Organização criada, mas o convite falhou: ${inviteError.message}`;
        }
      }

      return res.status(200).json({ success: true, org: { ...org, members: 0 }, warning });
    }

    // PATCH — renomear / arquivar / reativar.
    const id = readString(req.body, 'id');
    if (!id) {
      return res.status(400).json({ success: false, message: 'Informe o id da organização.' });
    }

    const update: Record<string, string> = {};
    const name = readString(req.body, 'name');
    const slug = readString(req.body, 'slug').toLowerCase();
    const status = readString(req.body, 'status');

    if (name) update.name = name;
    if (slug) {
      if (!SLUG_RE.test(slug)) {
        return res.status(400).json({
          success: false,
          message: 'Slug inválido. Use 2 a 40 caracteres: letras minúsculas, números e hífen.',
        });
      }
      const { data: existing, error: slugError } = await supabase
        .schema('whatsapp_hub')
        .from('organizations')
        .select('id')
        .eq('slug', slug)
        .neq('id', id)
        .maybeSingle();
      if (slugError) throw new Error(slugError.message);
      if (existing) {
        return res.status(409).json({ success: false, message: 'Já existe uma organização com esse slug.' });
      }
      update.slug = slug;
    }
    if (status) {
      if (status !== 'active' && status !== 'archived') {
        return res.status(400).json({ success: false, message: 'Status inválido.' });
      }
      update.status = status;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'Nada para atualizar.' });
    }

    const { data: updated, error: updateError } = await supabase
      .schema('whatsapp_hub')
      .from('organizations')
      .update(update)
      .eq('id', id)
      .select('id, name, slug, status, created_at')
      .single();
    if (updateError) throw new Error(updateError.message);

    return res.status(200).json({ success: true, org: updated });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
