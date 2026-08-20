import { createClient } from 'npm:@supabase/supabase-js@2.45.0';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const cache = new Map<string, { value: string | null; expiresAt: number }>();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getCryptoKey(
  usages: KeyUsage[] = ['decrypt'],
): Promise<CryptoKey> {
  const hex = Deno.env.get('CRYPTO_KEY');
  if (!hex || !/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error('CRYPTO_KEY ausente ou invalida');
  }
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(hex),
    { name: 'AES-GCM' },
    false,
    usages,
  );
}

function getSupabaseAdmin() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Decifra um payload "ivHex:tagHex:cipherHex" (AES-256-GCM). Exportado porque
// os tokens UAZAPI por canal ficam cifrados na linha de whatsapp_hub.channels.
export async function decryptValue(payload: string): Promise<string> {
  const [ivHex, tagHex, cipherHex] = payload.split(':');
  if (!ivHex || !tagHex || !cipherHex) {
    throw new Error('Payload de criptografia malformado');
  }
  const iv = hexToBytes(ivHex);
  const tag = hexToBytes(tagHex);
  const cipher = hexToBytes(cipherHex);
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher);
  combined.set(tag, cipher.length);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await getCryptoKey(['decrypt']),
    combined,
  );
  return decoder.decode(plain);
}

// Formato identico ao Node (src/lib/credentials.ts): "ivHex:tagHex:cipherHex",
// AES-256-GCM, IV de 12 bytes. WebCrypto anexa a tag (16 bytes) ao fim do
// ciphertext — separamos para casar o layout do Node.
export async function encryptValue(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await getCryptoKey(['encrypt']),
      encoder.encode(plaintext),
    ),
  );
  const tag = out.slice(out.length - 16);
  const cipher = out.slice(0, out.length - 16);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(cipher)}`;
}

// Credenciais são POR ORGANIZAÇÃO (public.org_settings). O orgId vem do JWT do
// caller, da linha alvo (conversa/campanha) ou da URL do webhook — nunca é
// implícito.
export async function getCredential(
  orgId: string,
  key: string,
): Promise<string | null> {
  const cacheKey = `${orgId}:${key}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('org_settings')
    .select('value_encrypted')
    .eq('org_id', orgId)
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  const value = data?.value_encrypted ? await decryptValue(data.value_encrypted) : null;
  cache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

export async function getCredentials(
  orgId: string,
  keys: string[],
): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = {};
  await Promise.all(keys.map(async (key) => {
    values[key] = await getCredential(orgId, key);
  }));
  return values;
}

// Escreve (cifrado) uma credencial em public.org_settings. Usado por handlers
// server-side que precisam atualizar derivados (ex.: cache de number-info
// quando chega um evento de saude do numero pelo webhook). A escrita normal de
// credenciais continua sendo via api/credentials (Node).
export async function setCredential(
  orgId: string,
  key: string,
  plaintext: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('org_settings')
    .upsert({
      org_id: orgId,
      key,
      value_encrypted: await encryptValue(plaintext),
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
  cache.set(`${orgId}:${key}`, { value: plaintext, expiresAt: Date.now() + 60_000 });
}

export function formatMissingCredential(key: string): string {
  return `Credencial ${key} nao configurada. Acesse /settings/credentials.`;
}

export function encodeWebhookVerifyToken(value: string): Uint8Array {
  return encoder.encode(value);
}
