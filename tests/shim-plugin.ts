import type { Plugin, Connect } from 'vite';
import { setupConfig } from '../setup.config';

// ---------------------------------------------------------------------------
// Offline /api shim for exercising the /setup wizard WITHOUT any real external
// effect. It replaces the Vercel serverless routes (api/*.ts) with in-process
// stubs so the wizard never:
//   - deploys Edge Functions / writes secrets (api/bootstrap.ts)
//   - mutates Supabase / Vercel (api/credentials.ts, api/bootstrap-status.ts)
//   - pings the real Meta / OpenAI / Supabase / Vercel APIs
//
// The ONLY app code exercised for real is the React wizard + the pure
// validators in setup.config.ts (the Meta/format checks the brief targets).
// Network leaves of those validators are neutralized by the global fetch guard
// below, so even a format-valid value never reaches a third party.
//
// Behaviour is driven per-test by the `x-shim-scenario` request header:
//   (default)        validate->ok, bootstrap->success, health->200
//   deploy-pending   health stays 503 (Step 3 shows "waiting for app")
//   bootstrap-error  /api/bootstrap returns success:false
//   idempotent       /api/bootstrap-status reports every checkpoint done
//   cred-error       /api/credentials returns 400 invalid credential
//   unauthorized     /api/credentials returns 401 (no/invalid session)
// ---------------------------------------------------------------------------

// Global fetch guard: any external host is answered with a canned response so
// no real network call leaves this process. Supabase/Vercel mgmt hosts answer
// 200 (so core field validation that DID reach a real route would pass); every
// other provider host answers 401 (so a format-valid provider key reads as
// "invalid" instead of phoning home). localhost passes through untouched.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  try {
    const host = new URL(url).host;
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
      return realFetch(input, init);
    }
    if (host === 'api.supabase.com' || host === 'api.vercel.com' || /\.supabase\.(co|in)$/.test(host)) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  } catch {
    return new Response('{}', { status: 400 });
  }
}) as typeof fetch;

type Json = Record<string, unknown>;

function readBody(req: Connect.IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: any, status: number, body: Json) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function scenario(req: Connect.IncomingMessage): string {
  const h = req.headers['x-shim-scenario'];
  return (Array.isArray(h) ? h[0] : h) ?? 'default';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Core (Step 2) field validation. URL/email/password are validated client-side
// in SetupPage; only the network-backed keys reach here, and offline we accept
// any non-empty value (real reachability can't be checked without live creds).
function validateCore(key: string, value: string): { ok: boolean; message: string } {
  const v = (value ?? '').trim();
  switch (key) {
    case 'supabase_anon_key':
    case 'supabase_service_role_key':
      return v ? { ok: true, message: 'Chave aceita.' } : { ok: false, message: 'Preencha URL e chave.' };
    case 'supabase_pat':
      return v ? { ok: true, message: 'PAT valido.' } : { ok: false, message: 'Informe o PAT.' };
    case 'vercel_token':
      return v ? { ok: true, message: 'Token Vercel valido.' } : { ok: false, message: 'Informe o token Vercel.' };
    default:
      return { ok: true, message: '' };
  }
}

export function apiShim(): Plugin {
  return {
    name: 'setup-api-shim',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/api/')) return next();
        const sc = scenario(req);

        // ---- /api/health (GET) : readiness probe polled by Step 3 ----------
        if (url === '/api/health') {
          if (sc === 'deploy-pending') return send(res, 503, { ready: false });
          return send(res, 200, { ready: true });
        }

        if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'method' });
        const body = await readBody(req);

        // ---- /api/validate : core + app credential checks ------------------
        if (url === '/api/validate') {
          const { kind, key, value, context } = body as {
            kind?: string;
            key?: string;
            value?: string;
            context?: Record<string, string>;
          };
          if (!key) return send(res, 400, { ok: false, message: 'key ausente.' });
          if (kind === 'app') {
            const field = setupConfig.appCredentials.find((f) => f.key === key);
            if (!field || (value ?? '').trim() === '') return send(res, 200, { ok: true });
            // Real validator runs; network leaves are neutralized by the guard.
            const result = await field.validate((value ?? '').trim());
            return send(res, 200, result as Json);
          }
          void context;
          return send(res, 200, validateCore(key, value ?? '') as Json);
        }

        // ---- /api/bootstrap : NEVER runs the real deploy -------------------
        if (url === '/api/bootstrap') {
          await sleep(500); // make the Step 3 loading state observable
          if (sc === 'bootstrap-error') {
            return send(res, 200, { success: false, message: 'Migration falhou no passo migrations_done.' });
          }
          return send(res, 200, { success: true });
        }

        // ---- /api/bootstrap-status : timeline hydration --------------------
        if (url === '/api/bootstrap-status') {
          if (sc === 'idempotent') {
            return send(res, 200, {
              completed: [
                'connection_ok',
                'migrations_done',
                'edge_functions_deployed',
                'owner_created',
                'vercel_envs_set',
                'redeploy_triggered',
              ],
            });
          }
          return send(res, 200, { completed: [] });
        }

        // ---- /api/credentials : vault write (stubbed, no real effect) ------
        if (url === '/api/credentials') {
          const auth = req.headers['authorization'];
          if (sc === 'unauthorized' || !auth) {
            return send(res, 401, { success: false, message: 'Sessao ausente.' });
          }
          if (sc === 'cred-error') {
            return send(res, 400, {
              success: false,
              error_code: 'INVALID_CREDENTIAL',
              message: 'Credencial invalida.',
            });
          }
          return send(res, 200, { success: true });
        }

        return send(res, 404, { ok: false, message: 'shim: rota desconhecida' });
      });
    },
  };
}
