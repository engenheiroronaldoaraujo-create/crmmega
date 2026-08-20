import { createClient } from '@supabase/supabase-js';
import { credentialExists, setCredential } from '../src/lib/credentials.js';
import { requireAdmin } from '../src/lib/admin-auth.js';
import { setupConfig } from '../setup.config.js';

type ApiRequest = {
  method?: string;
  query: { keys?: string; org_id?: string };
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeBody(body: unknown): Record<string, string> {
  const source =
    body && typeof body === 'object' && 'credentials' in body
      ? (body as { credentials: unknown }).credentials
      : body;
  if (!source || typeof source !== 'object') return {};
  const entries = Object.entries(source as Record<string, unknown>);
  return Object.fromEntries(
    entries.filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;
}

async function markAppCredentialsSaved() {
  const supabase = getSupabaseAdmin();
  await supabase.schema('public').from('_bootstrap_state').upsert({
    step: 'app_credentials_saved',
    completed_at: new Date().toISOString(),
    metadata: { source: 'api/credentials' },
  });
}

async function validateCredential(key: string, value: string) {
  const field = setupConfig.appCredentials.find((item) => item.key === key);
  if (!field || value.trim() === '') return { ok: true };
  return field.validate(value);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

    const auth = await requireAdmin(req.headers?.authorization ?? req.headers?.Authorization);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    // Credenciais são por org: admin opera na própria; super admin pode
    // apontar outra org via ?org_id= (console /admin).
    const requestedOrg = String(req.query.org_id ?? '').trim();
    if (requestedOrg && requestedOrg !== auth.orgId && !auth.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Acesso restrito à própria organização.' });
    }
    const orgId = requestedOrg || auth.orgId;

    if (req.method === 'GET') {
      const keys = String(req.query.keys ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      const exists = await credentialExists(orgId, keys);
      return res.status(200).json(
        Object.fromEntries(keys.map((key) => [key, { exists: Boolean(exists[key]) }])),
      );
    }

    const credentials = normalizeBody(req.body);
    for (const [key, value] of Object.entries(credentials)) {
      const result = await validateCredential(key, value);
      if (!result.ok) {
        return res.status(400).json({
          success: false,
          error_code: 'INVALID_CREDENTIAL',
          key,
          message: result.message ?? 'Credencial invalida.',
        });
      }
    }

    for (const [key, value] of Object.entries(credentials)) {
      if (value.trim() === '') continue;
      await setCredential(orgId, key, value.trim());
    }
    await markAppCredentialsSaved();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
