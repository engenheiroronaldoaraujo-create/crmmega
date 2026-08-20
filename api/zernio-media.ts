// ============================================================================
//  Proxy de mídia do Zernio (Vercel API Route)
//  ---------------------------------------------------------------------------
//  As URLs de mídia inbound (attachments do webhook) apontam para a API do
//  Zernio e exigem `Authorization: Bearer <zernio_api_key>` — o <img>/<audio>
//  do browser não tem (nem pode ter) essa key, então a thread renderizava
//  mídia quebrada. Este proxy:
//    · valida o access token Supabase da sessão (query `t`) — só usuário
//      logado consome mídia;
//    · whitelist: só repassa URLs https://zernio.com/api/v1/*  (não é open
//      proxy);
//    · injeta a API key (via getCredential, decriptada server-side) e faz o
//      stream do binário com o Content-Type original.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { getCredential } from '../src/lib/credentials.js';

type ApiRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};
type ApiResponse = {
  status: (code: number) => ApiResponse;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: unknown) => void;
  end: () => void;
};

const ZERNIO_PREFIX = 'https://zernio.com/api/v1/';

function qs(req: ApiRequest, name: string): string | null {
  const v = req.query?.[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const url = qs(req, 'url');
  const token = qs(req, 't');
  if (!url || !token) {
    res.status(400).json({ error: 'Parâmetros url e t são obrigatórios' });
    return;
  }
  if (!url.startsWith(ZERNIO_PREFIX)) {
    res.status(400).json({ error: 'URL fora da whitelist' });
    return;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) throw new Error('Supabase core não configurado.');

    // Sessão válida? (getUser valida assinatura + expiração do JWT)
    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: userData, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !userData?.user) {
      res.status(401).json({ error: 'Sessão inválida' });
      return;
    }

    // Credenciais são por org — a org vem do JWT da sessão validada.
    const orgId = (userData.user.app_metadata as { org_id?: string } | null)?.org_id;
    if (!orgId) {
      res.status(403).json({ error: 'Sessão sem organização. Faça login novamente.' });
      return;
    }

    const apiKey = await getCredential(orgId, 'zernio_api_key');
    if (!apiKey) {
      res.status(500).json({ error: 'Zernio não configurado' });
      return;
    }

    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).json({ error: `Zernio respondeu ${upstream.status}` });
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buf.length));
    // Mídia é imutável por id — cache no browser evita re-proxy a cada render.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).send(buf);
  } catch (err) {
    console.error(JSON.stringify({ event: 'zernio_media_proxy_error', message: err instanceof Error ? err.message : String(err) }));
    res.status(500).json({ error: 'Erro ao buscar mídia' });
  }
}
