// ============================================================================
// transcribe-audio  (trigger target)
// ----------------------------------------------------------------------------
// Called by the `on_audio_inbound` trigger whenever a contact sends an audio
// message. No modelo Zernio, o webhook ja entrega a URL do attachment direto em
// messages.media_url (nao ha mais lookup de media id na Graph API). O fluxo:
//
//   1. Load the message. Bail if it isn't an inbound audio row.
//   2. Download the audio bytes from media_url (URL do Zernio).
//   3. POST the bytes to OpenAI's Whisper `/v1/audio/transcriptions` endpoint
//      as multipart/form-data.
//   4. Update message.content with the transcription so the Inbox can render
//      text + preserve media_url for replay.
//
// On any failure we write a marker into content so the operator sees something
// actionable instead of a blank audio bubble.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';

interface MessageRow {
  id: string;
  org_id: string;
  direction: 'inbound' | 'outbound';
  content_type: string;
  media_url: string | null;
  content: string | null;
}

async function downloadAudio(url: string): Promise<{ blob: Blob; mime: string }> {
  // A URL do Zernio (media/upload-direct ou attachment do webhook) e
  // diretamente baixavel — sem Bearer da Meta.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download do audio ${res.status}`);
  const blob = await res.blob();
  const mime = res.headers.get('content-type') ?? 'audio/ogg';
  return { blob, mime };
}

// Re-dispara o pipeline da IA agora que o áudio virou texto (o trigger
// on_inbound_message só roda no INSERT; o UPDATE do content não re-dispara).
// Assim o agente responde a áudios (transcritos).
function reinvokeAiPipeline(messageId: string): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return;
  const run = fetch(`${url}/functions/v1/process-ai-message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: messageId }),
  })
    .then(() => undefined)
    .catch((err) => console.error(JSON.stringify({ event: 'transcribe_reinvoke_error', error: String(err) })));
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime?.waitUntil?.(run);
}

async function transcribeWithWhisper(openaiKey: string, blob: Blob, mime: string): Promise<string> {
  const form = new FormData();
  // Whisper sniffs the file from extension, so we hint the likely MIME. Meta
  // WhatsApp audio is usually OGG Opus.
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'mp4' : 'ogg';
  form.append('file', blob, `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`OpenAI whisper ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Whisper retornou texto vazio');
  }
  return text.trim();
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body: { message_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
  }
  if (!body.message_id) {
    return jsonResponse({ ok: false, error: 'message_id ausente.' }, { status: 400 });
  }

  const admin = getAdminClient();

  const { data: row, error: rowErr } = await admin
    .from('messages')
    .select('id, org_id, direction, content_type, media_url, content')
    .eq('id', body.message_id)
    .maybeSingle();
  if (rowErr || !row) {
    return jsonResponse({ ok: false, error: 'Mensagem não encontrada.' }, { status: 404 });
  }
  const message = row as MessageRow;

  if (message.direction !== 'inbound' || message.content_type !== 'audio') {
    return jsonResponse({ ok: true, skipped: 'not inbound audio' });
  }
  if (!message.media_url) {
    return jsonResponse({ ok: true, skipped: 'no media_url' });
  }

  const markFailure = async (reason: string) => {
    await admin
      .from('messages')
      .update({ content: `[áudio · transcrição falhou: ${reason}]` })
      .eq('id', message.id);
  };

  const creds = await loadAppCredentials(message.org_id);
  if (!creds.openai_api_key) {
    await markFailure('credencial OpenAI ausente');
    return jsonResponse({ ok: false, error: 'Credencial openai_api_key ausente. Acesse /settings/credentials.' }, { status: 400 });
  }

  try {
    const { blob, mime } = await downloadAudio(message.media_url);
    const transcript = await transcribeWithWhisper(creds.openai_api_key, blob, mime);

    await admin
      .from('messages')
      .update({ content: transcript })
      .eq('id', message.id);

    // Com o texto pronto, aciona a IA (ela pulou este áudio no INSERT).
    reinvokeAiPipeline(message.id);

    return jsonResponse({ ok: true, chars: transcript.length });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'erro desconhecido';
    await markFailure(reason);
    return jsonResponse({ ok: false, error: reason }, { status: 502 });
  }
});
