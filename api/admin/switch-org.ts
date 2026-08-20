import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '../../src/lib/admin-auth.js';

// ============================================================================
// api/admin/switch-org
// ----------------------------------------------------------------------------
// "Entrar como suporte": o super admin passa a operar em outra org sem trocar
// de sessão. Alteramos apenas app_metadata.org_id do próprio usuário; as demais
// claims (role, home_org_id, is_super_admin) são preservadas via merge — sem
// isso o super admin perderia o próprio status ao voltar.
//
//  POST { orgId }      → aponta para a org de suporte.
//  POST { back: true } → volta para home_org_id.
//
// O frontend chama supabase.auth.refreshSession() e recarrega para o novo
// org_id entrar no JWT.
// ============================================================================

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function readBody(body: unknown): { orgId: string; back: boolean } {
  if (!body || typeof body !== 'object') return { orgId: '', back: false };
  const record = body as Record<string, unknown>;
  return {
    orgId: typeof record.orgId === 'string' ? record.orgId.trim() : '',
    back: record.back === true,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    const auth = await requireSuperAdmin(
      req.headers?.authorization ?? req.headers?.Authorization,
    );
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    const { orgId, back } = readBody(req.body);
    const supabase = getSupabaseAdmin();

    // Lê o usuário atual para preservar as demais claims no merge.
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(auth.userId);
    if (userError || !userData?.user) {
      throw new Error(userError?.message ?? 'Não foi possível carregar o usuário.');
    }
    const currentMeta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;

    let targetOrgId: string;
    if (back) {
      const home = typeof currentMeta.home_org_id === 'string' ? currentMeta.home_org_id : '';
      if (!home) {
        return res.status(400).json({ success: false, message: 'Organização de origem não definida.' });
      }
      targetOrgId = home;
    } else {
      if (!orgId) {
        return res.status(400).json({ success: false, message: 'Informe a organização de destino.' });
      }
      const { data: org, error: orgError } = await supabase
        .schema('whatsapp_hub')
        .from('organizations')
        .select('id')
        .eq('id', orgId)
        .maybeSingle();
      if (orgError) throw new Error(orgError.message);
      if (!org) {
        return res.status(404).json({ success: false, message: 'Organização não encontrada.' });
      }
      targetOrgId = orgId;
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(auth.userId, {
      app_metadata: { ...currentMeta, org_id: targetOrgId },
    });
    if (updateError) throw new Error(updateError.message);

    return res.status(200).json({ success: true, orgId: targetOrgId });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
