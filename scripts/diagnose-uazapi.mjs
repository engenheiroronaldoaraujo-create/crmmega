// ============================================================================
// Diagnóstico da integração UAZAPI (envio + recebimento).
//
// Uso:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   CRYPTO_KEY=<64 hex> \
//   node scripts/diagnose-uazapi.mjs
//
// Verifica, na ordem em que as coisas quebram na prática:
//   1. Canais uazapi em whatsapp_hub.channels (is_active, org ativa)
//   2. Decifragem do token (CRYPTO_KEY da Vercel == do Supabase?)
//   3. GET /instance/status na UAZAPI (instância conectada ao WhatsApp?)
//   4. Webhooks cadastrados na instância (URL bate com o uazapi-webhook?)
//   5. POST de teste no uazapi-webhook (gateway aceita sem JWT? secret roteia?)
//   6. Últimas mensagens uazapi no banco (quando o fluxo parou?)
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { createDecipheriv } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRYPTO_KEY = process.env.CRYPTO_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

function decrypt(payload) {
  if (!CRYPTO_KEY || !/^[a-f0-9]{64}$/i.test(CRYPTO_KEY)) {
    throw new Error('CRYPTO_KEY ausente/inválida (64 hex) — passe a MESMA da Vercel');
  }
  const [ivHex, tagHex, cipherHex] = payload.split(':');
  if (!ivHex || !tagHex || !cipherHex) throw new Error('payload malformado');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(CRYPTO_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]).toString('utf8');
}

async function uazapi(serverUrl, token, path, init) {
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}${path}`, {
    method: init?.method ?? 'GET',
    headers: { token, 'Content-Type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: res.status, ok: res.ok, json, text };
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const hub = admin.schema('whatsapp_hub');

console.log('\n== 1. Canais UAZAPI no banco ==');
const { data: channels, error: chErr } = await hub
  .from('channels')
  .select('id, org_id, label, phone, is_active, ai_enabled, uazapi_server_url, uazapi_token_encrypted, webhook_secret, created_at')
  .eq('provider', 'uazapi')
  .order('created_at');
if (chErr) { bad(`erro lendo channels: ${chErr.message}`); process.exit(1); }
if (!channels?.length) { bad('nenhum canal provider=uazapi encontrado.'); process.exit(1); }

for (const ch of channels) {
  console.log(`\n— Canal "${ch.label}" (${ch.id}) org=${ch.org_id}`);
  ch.is_active ? ok('is_active=true') : bad('is_active=FALSE — envio via fallback getSoleUazapiChannel ignora este canal');

  const { data: org } = await hub.from('organizations').select('status, name').eq('id', ch.org_id).maybeSingle();
  org?.status === 'active'
    ? ok(`org "${org.name}" ativa`)
    : bad(`org status=${org?.status ?? '??'} — webhook descarta eventos de org arquivada`);

  if (!ch.uazapi_server_url || !ch.uazapi_token_encrypted) { bad('server_url/token ausentes no canal'); continue; }
  ok(`server_url: ${ch.uazapi_server_url}`);

  console.log('== 2. Decifragem do token ==');
  let token;
  try {
    token = decrypt(ch.uazapi_token_encrypted);
    ok('token decifrado com a CRYPTO_KEY informada');
  } catch (e) {
    bad(`falha ao decifrar token: ${e.message}`);
    warn('Se a CRYPTO_KEY é a mesma da Vercel, confira o secret CRYPTO_KEY das Edge Functions');
    warn('(Supabase Dashboard → Edge Functions → Secrets). Divergência = envio quebrado.');
    continue;
  }

  console.log('== 3. Status da instância UAZAPI ==');
  const st = await uazapi(ch.uazapi_server_url, token, '/instance/status');
  if (!st.ok) {
    bad(`GET /instance/status → HTTP ${st.status}: ${st.text.slice(0, 200)}`);
    if (st.status === 401) warn('Token inválido/rotacionado na UAZAPI — reconectar em /settings (Canais).');
    continue;
  }
  const inst = st.json.instance ?? st.json;
  const status = inst.status ?? st.json.status ?? '??';
  const connected = st.json.connected === true || inst.connected === true || String(status).toLowerCase() === 'connected';
  connected ? ok(`instância conectada (status=${status})`) : bad(`instância NÃO conectada (status=${status}) — reparear o WhatsApp (QR code) na UAZAPI`);

  console.log('== 4. Webhook cadastrado na instância ==');
  const expectedUrl = `${SUPABASE_URL}/functions/v1/uazapi-webhook?secret=${ch.webhook_secret}`;
  const wh = await uazapi(ch.uazapi_server_url, token, '/webhook');
  const list = Array.isArray(wh.json) ? wh.json
    : Array.isArray(wh.json.webhooks) ? wh.json.webhooks
    : wh.json.webhook ? [wh.json.webhook]
    : wh.json.url ? [wh.json] : [];
  if (!wh.ok) {
    warn(`GET /webhook → HTTP ${wh.status} (algumas versões só aceitam POST): ${wh.text.slice(0, 150)}`);
  } else if (!list.length) {
    bad('nenhum webhook cadastrado na instância — recebimento quebrado. Reconecte o canal em /settings para recadastrar.');
  } else {
    for (const w of list) {
      const match = w.url === expectedUrl;
      const line = `url=${w.url} enabled=${w.enabled} events=${JSON.stringify(w.events ?? w.AddUrlEvents ?? null)}`;
      match ? ok(`webhook correto: ${line}`) : warn(`webhook divergente: ${line}`);
      if (match && w.enabled === false) bad('webhook existe mas está DESABILITADO');
    }
    if (!list.some((w) => w.url === expectedUrl)) {
      bad(`nenhum webhook aponta para a URL esperada:\n     ${expectedUrl}`);
    }
  }

  console.log('== 5. Gateway do uazapi-webhook (verify_jwt / roteamento) ==');
  const probe = await fetch(`${SUPABASE_URL}/functions/v1/uazapi-webhook?secret=${ch.webhook_secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'connection', data: { probe: true } }),
  });
  const probeText = await probe.text();
  if (probe.status === 401) {
    bad('gateway respondeu 401 — função deployada com verify_jwt=true. Redeploy com --no-verify-jwt (npm run functions:deploy).');
  } else if (probe.ok) {
    let pj = {}; try { pj = JSON.parse(probeText); } catch { /* noop */ }
    pj.skipped === 'no_channel'
      ? bad('função respondeu skipped=no_channel — o secret da URL não casa com channels.webhook_secret')
      : ok(`função aceitou o evento (HTTP ${probe.status}: ${probeText.slice(0, 120)})`);
  } else {
    bad(`uazapi-webhook → HTTP ${probe.status}: ${probeText.slice(0, 200)}`);
  }

  console.log('== 6. Últimas mensagens desta org ==');
  const { data: convs } = await hub
    .from('conversations')
    .select('id')
    .eq('org_id', ch.org_id)
    .eq('provider', 'uazapi');
  const convIds = (convs ?? []).map((c) => c.id);
  if (!convIds.length) {
    warn('nenhuma conversa provider=uazapi nesta org (nunca recebeu ou provider divergente).');
  } else {
    const { data: msgs } = await hub
      .from('messages')
      .select('created_at, direction, sender_type, content_type, meta_status')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(8);
    for (const m of msgs ?? []) {
      console.log(`  ${m.created_at}  ${m.direction.padEnd(8)} ${m.sender_type.padEnd(8)} ${m.content_type.padEnd(8)} meta_status=${m.meta_status ?? '-'}`);
    }
    const lastFailed = (msgs ?? []).filter((m) => m.meta_status === 'failed').length;
    if (lastFailed) warn(`${lastFailed} das últimas 8 mensagens com meta_status=failed → falha no ENVIO (decrypt/instância/token).`);
  }
}

console.log('\nDiagnóstico concluído.');
