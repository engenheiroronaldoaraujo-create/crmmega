import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type BootstrapBody = {
  supabase_url?: string;
  supabase_anon_key?: string;
  supabase_service_role_key?: string;
  supabase_pat?: string;
  vercel_token?: string;
  owner_email?: string;
  owner_password?: string;
  vercel_project_id?: string;
};

type ApiRequest = {
  method?: string;
  body?: BootstrapBody;
  headers: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

const BOOTSTRAP_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public._bootstrap_state (
  step text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);
ALTER TABLE public._bootstrap_state ENABLE ROW LEVEL SECURITY;
`;

function jsonString(value: unknown) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function projectRef(url: string) {
  const match = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)$/i);
  if (!match) throw new Error('SUPABASE_URL invalida.');
  return match[1];
}

// ---------------------------------------------------------------------------
// Retry com backoff exponencial para as APIs externas (Supabase Management,
// Auth, Vercel). A Management API tem rate limit (~60 req/min) e devolve 429
// (ThrottlerException) quando estourado; 5xx transitórios também acontecem.
// Sem retry, um único 429 derruba o bootstrap inteiro na cara do aluno.
// Respeita o header Retry-After quando presente; senão 2s, 4s, 8s, 16s, 32s.
// Devolve a Response final (ok ou não) — o caller mantém o próprio throw.
// ---------------------------------------------------------------------------
const RETRY_ATTEMPTS = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const retryAfter = Number(res?.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2000 * 2 ** (attempt - 1);
      await sleep(Math.min(backoffMs, 60_000));
    }
    res = await fetch(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
  }
  return res!;
}

async function supabaseQuery(ref: string, pat: string, query: string) {
  const res = await fetchWithRetry(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase database/query ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function mark(ref: string, pat: string, step: string, metadata: unknown = {}) {
  await supabaseQuery(
    ref,
    pat,
    `INSERT INTO public._bootstrap_state (step, completed_at, metadata)
     VALUES ('${step.replaceAll("'", "''")}', now(), '${jsonString(metadata)}'::jsonb)
     ON CONFLICT (step) DO NOTHING;`,
  );
}

async function hasStep(ref: string, pat: string, step: string) {
  const rows = await supabaseQuery(
    ref,
    pat,
    `SELECT step FROM public._bootstrap_state WHERE step = '${step.replaceAll("'", "''")}';`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getStepMetadata(ref: string, pat: string, step: string) {
  const rows = await supabaseQuery(
    ref,
    pat,
    `SELECT metadata FROM public._bootstrap_state WHERE step = '${step.replaceAll("'", "''")}';`,
  );
  return Array.isArray(rows) && rows[0]?.metadata
    ? (rows[0].metadata as Record<string, unknown>)
    : null;
}

function substitute(sql: string, body: Required<BootstrapBody>, cryptoKey: string) {
  return sql
    .replaceAll('__SUPABASE_URL__', body.supabase_url)
    .replaceAll('__SUPABASE_SERVICE_ROLE_KEY__', body.supabase_service_role_key)
    .replaceAll('__WHATSAPP_HUB_ENCRYPTION_KEY__', cryptoKey);
}

// Executa as migrations pendentes em CHUNKS: várias migrations por chamada de
// /database/query, com o INSERT do checkpoint logo após o SQL de cada uma.
// Motivo: rodar 78 migrations com 2 chamadas cada (~156 requests) estoura o
// rate limit da Management API (~60 req/min) → 429 ThrottlerException, e o
// tempo total passa do maxDuration da function → 504. Em chunks são ~8 calls.
// Cada chamada roda numa transação única: se uma migration do chunk falhar,
// nada do chunk é marcado e o retry re-executa só os chunks pendentes —
// mesma idempotência do modelo antigo. O RESET ALL entre migrations emula a
// sessão nova que cada uma tinha antes (nem todas definem search_path).
const CHUNK_MAX_FILES = 10;
const CHUNK_MAX_BYTES = 200_000;

async function completedSteps(ref: string, pat: string): Promise<Set<string>> {
  const rows = await supabaseQuery(ref, pat, 'SELECT step FROM public._bootstrap_state;');
  return new Set(Array.isArray(rows) ? rows.map((row: { step?: string }) => String(row.step)) : []);
}

async function runMigrations(ref: string, pat: string, body: Required<BootstrapBody>, cryptoKey: string) {
  const files = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort();
  const done = await completedSteps(ref, pat);
  const pending = files.filter((file) => !done.has(`migration:${file}`));

  let chunk: string[] = [];
  let chunkBytes = 0;
  const flush = async () => {
    if (!chunk.length) return;
    await supabaseQuery(ref, pat, chunk.join('\n'));
    chunk = [];
    chunkBytes = 0;
  };

  for (const file of pending) {
    const raw = readFileSync(join('supabase/migrations', file), 'utf8');
    const sql = substitute(raw, body, cryptoKey);
    const piece = `RESET ALL;\n${sql}\nINSERT INTO public._bootstrap_state (step, completed_at, metadata)
VALUES ('migration:${file.replaceAll("'", "''")}', now(), '{}'::jsonb)
ON CONFLICT (step) DO NOTHING;\n`;
    if (chunk.length >= CHUNK_MAX_FILES || chunkBytes + piece.length > CHUNK_MAX_BYTES) await flush();
    chunk.push(piece);
    chunkBytes += piece.length;
  }
  await flush();
}

async function setSupabaseSecrets(ref: string, pat: string, cryptoKey: string) {
  // SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetadas automaticamente nas
  // Edge Functions pelo runtime do Supabase — não podem ser setadas como secret
  // (a Management API rejeita o prefixo reservado SUPABASE_). Só a CRYPTO_KEY,
  // que é custom (decifra public.app_settings), precisa ser setada aqui.
  const secrets = [
    { name: 'CRYPTO_KEY', value: cryptoKey },
  ];
  const res = await fetchWithRetry(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(secrets),
  });
  if (!res.ok) throw new Error(`Falha ao setar secrets Supabase: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Edge Function deploy: multipart em POST /v1/projects/{ref}/functions/deploy
// ---------------------------------------------------------------------------
// O endpoint JSON (PATCH/POST /functions/{slug} com campo `body`) atualiza os
// METADADOS mas grava o código VAZIO — a função fica ACTIVE porém responde
// 503 BOOT_ERROR em toda chamada. O formato correto é o mesmo da CLI:
// multipart/form-data com `metadata` (entrypoint_path, verify_jwt) e um part
// `file` por arquivo-fonte, preservando os caminhos relativos do repo para os
// imports ../_shared/* resolverem em runtime (sem bundler próprio).
// ---------------------------------------------------------------------------

const SHARED_DIR = 'supabase/functions/_shared';

function sharedFiles(): string[] {
  return readdirSync(SHARED_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function edgeFunctions() {
  return readdirSync('supabase/functions')
    .filter((name) => {
      const path = join('supabase/functions', name);
      return statSync(path).isDirectory() && !name.startsWith('_');
    })
    .sort();
}

// Funcões chamadas por serviços externos que NÃO carregam um JWT do Supabase.
// Elas se autenticam sozinhas (HMAC no header ou secret na URL), então precisam
// ser deployadas com verify_jwt=false — senão o gateway do Supabase rejeita
// (401) todo evento antes do handler rodar. Os crons/triggers (dispatch,
// follow-ups, funnel-automation, etc.) chegam via pg_net com o service role key
// como Bearer, que É um JWT válido, então mantêm verify_jwt=true.
const NO_JWT_FUNCTIONS = new Set(['zernio-webhook', 'uazapi-webhook']);

async function deployEdgeFunctions(ref: string, pat: string) {
  const functions = edgeFunctions();
  const shared = sharedFiles();
  for (const slug of functions) {
    const entrypoint = `supabase/functions/${slug}/index.ts`;
    const form = new FormData();
    form.append('metadata', JSON.stringify({
      name: slug,
      entrypoint_path: entrypoint,
      verify_jwt: !NO_JWT_FUNCTIONS.has(slug),
    }));
    const addFile = (path: string) => {
      form.append(
        'file',
        new Blob([readFileSync(path, 'utf8')], { type: 'application/typescript' }),
        path,
      );
    };
    addFile(entrypoint);
    for (const name of shared) addFile(`${SHARED_DIR}/${name}`);
    // Content-Type fica por conta do fetch (boundary do multipart).
    const res = await fetchWithRetry(
      `https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${slug}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}` },
        body: form,
      },
    );
    if (!res.ok) throw new Error(`Falha ao deployar ${slug}: ${await res.text()}`);
  }
  return functions.length;
}

async function findUser(body: Required<BootstrapBody>) {
  const res = await fetchWithRetry(
    `${body.supabase_url}/auth/v1/admin/users?email=${encodeURIComponent(body.owner_email)}`,
    {
      headers: {
        apikey: body.supabase_service_role_key,
        Authorization: `Bearer ${body.supabase_service_role_key}`,
      },
    },
  );
  if (!res.ok) return null;
  const json = await res.json();
  const users = Array.isArray(json.users) ? json.users : Array.isArray(json) ? json : [];
  return users.find((user: { email?: string }) => user.email?.toLowerCase() === body.owner_email.toLowerCase()) ?? null;
}

async function createOwner(ref: string, pat: string, body: Required<BootstrapBody>) {
  let user = await findUser(body);
  if (!user) {
    const res = await fetchWithRetry(`${body.supabase_url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: body.supabase_service_role_key,
        Authorization: `Bearer ${body.supabase_service_role_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: body.owner_email,
        password: body.owner_password,
        email_confirm: true,
        user_metadata: { created_via: 'setup_wizard' },
        app_metadata: { role: 'admin' },
      }),
    });
    if (!res.ok) throw new Error(`Falha ao criar owner: ${await res.text()}`);
    user = await res.json();
  }
  const id = user.id;
  // Multi-tenant: o owner do bootstrap é admin + SUPER ADMIN da org padrão
  // (criada pela migration de backfill). O trigger handle_new_user já cobre o
  // caso do 1º usuário; este SQL é o cinto de segurança idempotente para
  // re-runs (usuário pré-existente não dispara o trigger de novo).
  await supabaseQuery(
    ref,
    pat,
    `DO $$
     DECLARE v_org uuid;
     BEGIN
       SELECT id INTO v_org FROM whatsapp_hub.organizations
        WHERE status = 'active' ORDER BY created_at LIMIT 1;
       IF v_org IS NULL THEN
         INSERT INTO whatsapp_hub.organizations (name, slug)
         VALUES ('Organização Principal', 'principal')
         RETURNING id INTO v_org;
       END IF;

       INSERT INTO whatsapp_hub.app_users (user_id, org_id, role, is_super_admin, accepted_at)
       VALUES ('${id}', v_org, 'admin', true, now())
       ON CONFLICT (user_id) DO UPDATE
         SET role = 'admin',
             is_super_admin = true,
             org_id = COALESCE(whatsapp_hub.app_users.org_id, v_org),
             accepted_at = COALESCE(whatsapp_hub.app_users.accepted_at, now());

       UPDATE auth.users
          SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                                || jsonb_build_object(
                                     'role', 'admin',
                                     'org_id', v_org::text,
                                     'home_org_id', v_org::text,
                                     'is_super_admin', true
                                   )
        WHERE id = '${id}';

       PERFORM whatsapp_hub.seed_org_defaults(v_org);
     END $$;`,
  );
  return id as string;
}

// ---------------------------------------------------------------------------
// Escopo de time da Vercel. Contas novas da Vercel colocam todo projeto sob um
// time default (slug "xxx-projects-<hash>"). A API devolve 403 forbidden
// ("Trying to access resource under scope ...") para recursos de time quando a
// chamada não carrega ?teamId=. Descobrimos o teamId dono do projeto uma vez e
// carimbamos em todas as chamadas (envs + redeploy). null = escopo pessoal
// legado (sem teamId).
// ---------------------------------------------------------------------------
function withTeam(url: string, teamId: string | null) {
  if (!teamId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(teamId)}`;
}

async function resolveVercelTeamId(projectId: string, token: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${token}` };
  const direct = await fetchWithRetry(`https://api.vercel.com/v9/projects/${projectId}`, { headers });
  if (direct.ok) return null;

  const teamsRes = await fetchWithRetry('https://api.vercel.com/v2/teams?limit=100', { headers });
  if (teamsRes.ok) {
    const json = await teamsRes.json();
    const teams: { id?: string }[] = Array.isArray(json.teams) ? json.teams : [];
    for (const team of teams) {
      if (!team.id) continue;
      const res = await fetchWithRetry(
        withTeam(`https://api.vercel.com/v9/projects/${projectId}`, team.id),
        { headers },
      );
      if (res.ok) return team.id;
    }
  }
  throw new Error(
    'Token da Vercel sem acesso ao projeto. Gere um novo Access Token com escopo '
    + '"Full Account" (ou do time onde o projeto está) em vercel.com/account/tokens '
    + 'e tente de novo.',
  );
}

async function setVercelEnv(projectId: string, token: string, teamId: string | null, key: string, value: string) {
  const res = await fetchWithRetry(
    withTeam(`https://api.vercel.com/v10/projects/${projectId}/env?upsert=true`, teamId),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, type: 'encrypted', target: ['production', 'preview', 'development'] }),
    },
  );
  if (!res.ok) throw new Error(`Falha ao setar env ${key} na Vercel: ${await res.text()}`);
}

async function redeploy(projectId: string, token: string, teamId: string | null) {
  // Procura o último deployment de produção pronto para servir de base ao
  // redeploy. Sem o filtro target=production poderíamos pegar um preview.
  const deployments = await fetchWithRetry(
    withTeam(`https://api.vercel.com/v6/deployments?projectId=${projectId}&target=production&limit=1`, teamId),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!deployments.ok) throw new Error(`Falha ao buscar deployment Vercel: ${await deployments.text()}`);
  const json = await deployments.json();
  const latest = json.deployments?.[0];
  if (!latest?.uid) {
    throw new Error('Projeto Vercel sem deployment de produção anterior — não há base para redeploy');
  }
  // A Vercel não expõe um endpoint /redeploy. Redeploy = criar um novo
  // deployment referenciando o `deploymentId` anterior (reusa o mesmo commit
  // git, mas com o build novo que captura as envs core recém-setadas).
  // `name` é obrigatório; `forceNew=1` garante um build fresco em vez de
  // devolver o deployment idêntico já existente.
  const res = await fetchWithRetry(withTeam('https://api.vercel.com/v13/deployments?forceNew=1', teamId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: latest.name, deploymentId: latest.uid, target: 'production' }),
  });
  if (!res.ok) throw new Error(`Falha ao disparar redeploy: ${await res.text()}`);
  const redeployed = await res.json();
  return { id: redeployed.id ?? redeployed.uid ?? latest.uid, url: redeployed.url ?? latest.url ?? '' };
}

function requireBody(body: BootstrapBody | undefined): Required<BootstrapBody> {
  const required = [
    'supabase_url',
    'supabase_anon_key',
    'supabase_service_role_key',
    'supabase_pat',
    'vercel_token',
    'owner_email',
    'owner_password',
  ] as const;
  for (const key of required) {
    if (!body?.[key]) throw new Error(`Campo ${key} ausente.`);
  }
  return {
    ...body,
    vercel_project_id: body.vercel_project_id ?? process.env.VERCEL_PROJECT_ID ?? '',
  } as Required<BootstrapBody>;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  let stepFailed = 'unknown';
  try {
    const body = requireBody(req.body);
    const ref = projectRef(body.supabase_url);
    const cryptoKey = /^[a-f0-9]{64}$/i.test(process.env.CRYPTO_KEY ?? '')
      ? process.env.CRYPTO_KEY as string
      : randomBytes(32).toString('hex');
    const steps: string[] = [];

    stepFailed = 'bootstrap_state';
    await supabaseQuery(ref, body.supabase_pat, BOOTSTRAP_TABLE_SQL);
    await mark(ref, body.supabase_pat, 'connection_ok');
    steps.push('connection_ok');

    stepFailed = 'migrations';
    await runMigrations(ref, body.supabase_pat, body, cryptoKey);
    await mark(ref, body.supabase_pat, 'migrations_done');
    steps.push('migrations_done');

    stepFailed = 'edge_functions';
    await setSupabaseSecrets(ref, body.supabase_pat, cryptoKey);
    const count = await deployEdgeFunctions(ref, body.supabase_pat);
    await mark(ref, body.supabase_pat, 'edge_functions_deployed', { count });
    steps.push('edge_functions_deployed');

    stepFailed = 'owner_created';
    const ownerId = await createOwner(ref, body.supabase_pat, body);
    await mark(ref, body.supabase_pat, 'owner_created', { user_id: ownerId, email: body.owner_email });
    steps.push('owner_created');

    stepFailed = 'vercel_envs_set';
    if (!body.vercel_project_id) {
      throw new Error('VERCEL_PROJECT_ID ausente no runtime (esperado como system env var injetada pela Vercel).');
    }
    const teamId = await resolveVercelTeamId(body.vercel_project_id, body.vercel_token);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, teamId, 'SUPABASE_URL', body.supabase_url);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, teamId, 'SUPABASE_ANON_KEY', body.supabase_anon_key);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, teamId, 'SUPABASE_SERVICE_ROLE_KEY', body.supabase_service_role_key);
    await setVercelEnv(body.vercel_project_id, body.vercel_token, teamId, 'CRYPTO_KEY', cryptoKey);
    await mark(ref, body.supabase_pat, 'vercel_envs_set');
    steps.push('vercel_envs_set');

    stepFailed = 'redeploy';
    // Idempotente: um re-run não dispara um novo deployment. Se já marcamos
    // redeploy_triggered, reaproveitamos o deployment do checkpoint.
    let deployment: { id: string; url: string };
    if (await hasStep(ref, body.supabase_pat, 'redeploy_triggered')) {
      const meta = await getStepMetadata(ref, body.supabase_pat, 'redeploy_triggered');
      deployment = {
        id: typeof meta?.deployment_id === 'string' ? meta.deployment_id : '',
        url: typeof meta?.deployment_url === 'string' ? meta.deployment_url : '',
      };
    } else {
      deployment = await redeploy(body.vercel_project_id, body.vercel_token, teamId);
      await mark(ref, body.supabase_pat, 'redeploy_triggered', {
        deployment_id: deployment.id,
        deployment_url: deployment.url,
        triggered_at: new Date().toISOString(),
      });
    }
    steps.push('redeploy_triggered');

    return res.status(200).json({
      success: true,
      steps_completed: steps,
      deployment_id: deployment.id,
      deployment_url: deployment.url,
      owner_user_id: ownerId,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      step_failed: stepFailed,
      error_code: 'BOOTSTRAP_FAILED',
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
