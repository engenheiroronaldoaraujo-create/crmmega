// ============================================================================
// _shared/uazapi.ts — client da UAZAPI (Deno, Edge Functions)
// ----------------------------------------------------------------------------
// Integração DIRETA com a instância UAZAPI (segundo número de WhatsApp, sem
// janela de 24h): base URL = channels.uazapi_server_url, auth via header
// `token: <uazapi_token_encrypted decifrado>`. Multi-número: cada instância
// UAZAPI é um CANAL (whatsapp_hub.channels, provider='uazapi') da org.
// Spec: docs.uazapi.com (openapi-bundled.json) — POST /send/text {number,text},
// POST /send/media {number,type,file,text?}, POST /chat/details {number,preview}.
// ============================================================================

import { decryptValue } from './credentials.ts';

export class UazapiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface UazapiContext {
  serverUrl: string;
  token: string;
}

// Monta o contexto a partir de uma linha de whatsapp_hub.channels
// (provider='uazapi'). O token fica cifrado na linha (AES-GCM/CRYPTO_KEY).
export async function uazapiContextFromChannel(channel: {
  uazapi_server_url: string | null;
  uazapi_token_encrypted: string | null;
}): Promise<UazapiContext> {
  const serverUrl = channel.uazapi_server_url?.trim().replace(/\/+$/, '');
  const encrypted = channel.uazapi_token_encrypted?.trim();
  if (!serverUrl || !encrypted) {
    throw new UazapiError('Canal UAZAPI sem server URL / token configurados.', 500);
  }
  return { serverUrl, token: await decryptValue(encrypted) };
}

async function ufetch(
  ctx: UazapiContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${ctx.serverUrl}${path}`, {
    method: 'POST',
    headers: { token: ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* segue para o gate de status */
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

function messageIdOf(root: Record<string, unknown>): string | null {
  const nested = (root.message && typeof root.message === 'object'
    ? (root.message as Record<string, unknown>)
    : root);
  for (const key of ['messageid', 'id', 'messageId']) {
    const v = nested[key] ?? root[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// Telefone E.164/dígitos — a UAZAPI aceita número internacional sem '+'.
function toNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

export async function uazapiSendText(
  ctx: UazapiContext,
  input: { phone: string; text: string },
): Promise<{ messageId: string | null }> {
  const root = await ufetch(ctx, '/send/text', {
    number: toNumber(input.phone),
    text: input.text,
  });
  return { messageId: messageIdOf(root) };
}

export async function uazapiSendMedia(
  ctx: UazapiContext,
  input: {
    phone: string;
    // Mapeado do attachmentType do inbox: image|video|audio(ptt)|file(document).
    type: 'image' | 'video' | 'document' | 'audio' | 'ptt';
    fileUrl: string;
    caption?: string;
  },
): Promise<{ messageId: string | null }> {
  const body: Record<string, unknown> = {
    number: toNumber(input.phone),
    type: input.type,
    file: input.fileUrl,
  };
  if (input.caption) body.text = input.caption;
  const root = await ufetch(ctx, '/send/media', body);
  return { messageId: messageIdOf(root) };
}

// POST /chat/details {number, preview} → detalhes completos do chat/contato,
// incluindo a URL da foto de perfil: `imagePreview` (menor, preview=true) ou
// `image` (resolução original, preview=false). Usada para exibir o avatar do
// lead no inbox (só disponível via UAZAPI — Zernio/Meta não expõem).
export async function uazapiGetChatDetails(
  ctx: UazapiContext,
  input: { phone: string; preview?: boolean },
): Promise<{ imageUrl: string | null; name: string | null }> {
  const root = await ufetch(ctx, '/chat/details', {
    number: toNumber(input.phone),
    preview: input.preview ?? true,
  });
  const pick = (keys: string[]): string | null => {
    for (const key of keys) {
      const v = root[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  };
  return {
    imageUrl: pick(['imagePreview', 'image']),
    name: pick(['wa_contactName', 'wa_name', 'name', 'lead_name']),
  };
}
