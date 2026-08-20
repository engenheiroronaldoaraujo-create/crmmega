import { setupConfig } from '../setup.config.js';

// Server-side validation proxy. The frontend used to ping api.supabase.com,
// api.vercel.com and the third-party provider APIs (OpenAI/Meta/etc.) directly
// from the browser, leaking PATs/tokens/API keys into client network traffic.
// Now the browser sends the value here and the server runs the check, so no
// application credential ever leaves through the frontend. The endpoint only
// returns { ok, message } — it never stores anything.

type ApiRequest = {
  method?: string;
  body?: unknown;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

type ValidateBody = {
  kind?: 'app' | 'core';
  key?: string;
  value?: string;
  context?: Record<string, string>;
};

type Result = { ok: boolean; message?: string };

const SUPABASE_URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i;

async function ping(url: string, headers: HeadersInit): Promise<boolean> {
  try {
    const res = await fetch(url, { headers });
    return res.ok;
  } catch {
    return false;
  }
}

async function validateCore(
  key: string,
  value: string,
  context: Record<string, string>,
): Promise<Result> {
  const v = value.trim();
  switch (key) {
    case 'supabase_anon_key':
    case 'supabase_service_role_key': {
      const url = (context.supabase_url ?? '').trim().replace(/\/$/, '');
      if (!url || !v) return { ok: false, message: 'Preencha URL e chave.' };
      // Guard against SSRF: only ping a real Supabase project host.
      if (!SUPABASE_URL_RE.test(url)) {
        return { ok: false, message: 'SUPABASE_URL invalida.' };
      }
      return (await ping(`${url}/auth/v1/settings`, { apikey: v }))
        ? { ok: true, message: 'Chave aceita.' }
        : { ok: false, message: 'Chave rejeitada pelo Supabase.' };
    }
    case 'supabase_pat':
      if (!v) return { ok: false, message: 'Informe o PAT.' };
      return (await ping('https://api.supabase.com/v1/projects', {
        Authorization: `Bearer ${v}`,
      }))
        ? { ok: true, message: 'PAT valido.' }
        : { ok: false, message: 'PAT invalido ou sem permissao.' };
    case 'vercel_token':
      if (!v) return { ok: false, message: 'Informe o token Vercel.' };
      return (await ping('https://api.vercel.com/v2/user', {
        Authorization: `Bearer ${v}`,
      }))
        ? { ok: true, message: 'Token Vercel valido.' }
        : { ok: false, message: 'Token Vercel invalido.' };
    default:
      // Regex-only fields (supabase_url, owner_email, owner_password) are
      // validated client-side; nothing to check here.
      return { ok: true };
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { kind, key, value, context } = (req.body ?? {}) as ValidateBody;
    if (!key) return res.status(400).json({ ok: false, message: 'key ausente.' });

    if (kind === 'app') {
      const field = setupConfig.appCredentials.find((item) => item.key === key);
      if (!field || (value ?? '').trim() === '') return res.status(200).json({ ok: true });
      const result = await field.validate((value ?? '').trim());
      return res.status(200).json(result);
    }

    const result = await validateCore(key, value ?? '', context ?? {});
    return res.status(200).json(result);
  } catch (err) {
    return res
      .status(200)
      .json({ ok: false, message: err instanceof Error ? err.message : 'Falha ao validar.' });
  }
}
