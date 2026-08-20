// ============================================================================
// Client UAZAPI (Node — API Routes da Vercel; usado só em setup/conexão).
// Integração DIRETA com a instância UAZAPI: base URL = server da instância,
// auth via header `token: <instance token>`.
// Spec: docs.uazapi.com (openapi-bundled.json).
// ============================================================================

export class UazapiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function ufetch(
  serverUrl: string,
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${normalizeServer(serverUrl)}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: init?.body != null ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* respostas não-JSON caem no erro abaixo */
  }
  if (!res.ok) {
    const msg =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.message === 'string' && json.message) ||
      `UAZAPI respondeu ${res.status}`;
    throw new UazapiError(msg, res.status);
  }
  return json;
}

// GET /instance/status → estado da instância (conectada ao WhatsApp?).
export async function instanceStatus(
  serverUrl: string,
  token: string,
): Promise<{ connected: boolean; status: string | null; raw: Record<string, unknown> }> {
  const root = await ufetch(serverUrl, token, '/instance/status');
  const inst = (root.instance && typeof root.instance === 'object'
    ? (root.instance as Record<string, unknown>)
    : root);
  const status =
    (typeof inst.status === 'string' && inst.status) ||
    (typeof root.status === 'string' && root.status) ||
    null;
  const connected =
    root.connected === true ||
    inst.connected === true ||
    (status ?? '').toLowerCase() === 'connected';
  return { connected, status, raw: root };
}

// POST /webhook — cria/atualiza o webhook da instância. Config espelhando o
// padrão usado manualmente: POST, events connection+messages, excluindo
// wasSentByApi (anti-loop) e isGroupYes (sem grupos).
export async function configureWebhook(
  serverUrl: string,
  token: string,
  input: { url: string; existingId?: string | null },
): Promise<{ id: string | null }> {
  const body: Record<string, unknown> = {
    enabled: true,
    url: input.url,
    events: ['connection', 'messages'],
    excludeMessages: ['wasSentByApi', 'isGroupYes'],
    addUrlEvents: false,
    addUrlTypesMessages: false,
    action: input.existingId ? 'update' : 'add',
  };
  if (input.existingId) body.id = input.existingId;
  const root = await ufetch(serverUrl, token, '/webhook', { method: 'POST', body });
  // Resposta pode vir como { webhook: {...} } | { webhooks: [...] } | objeto direto.
  const wh = (root.webhook && typeof root.webhook === 'object'
    ? (root.webhook as Record<string, unknown>)
    : Array.isArray(root.webhooks)
      ? ((root.webhooks as Record<string, unknown>[]).find((w) => w.url === input.url) ?? {})
      : root);
  const id = typeof wh.id === 'string' ? wh.id : typeof root.id === 'string' ? root.id : null;
  return { id };
}
