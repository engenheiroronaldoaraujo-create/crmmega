// ============================================================================
// process-knowledge
// ----------------------------------------------------------------------------
// Takes a knowledge_base row and turns it into searchable RAG chunks:
//
//   1. Loads the target KB row.
//   2. Fetches plaintext from the source (raw text passed in, or URL fetch
//      with a rough HTML-strip).
//   3. Chunks the text into ~500-token windows with 50-token overlap. We
//      approximate tokens as chars / 4 — cheap heuristic that's accurate
//      enough for embeddings, and keeps the chunker dependency-free.
//   4. Calls OpenAI embeddings in batches of 100 inputs with openai_api_key
//      from encrypted app settings to produce 1536-dim vectors.
//   5. Inserts the chunks + vectors into knowledge_chunks and marks the KB
//      status='ready' (or 'error' on failure).
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
// npm: specifier em vez de esm.sh — o build serverless do unpdf (pdfjs-serverless)
// é mais confiável no runtime Deno do Supabase Edge para extrair texto de PDF.
import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';

type SourceType = 'text' | 'url' | 'pdf';

interface Payload {
  knowledge_base_id?: string;
  source_type?: SourceType;
  // For text: raw text. For url: the URL. For pdf: the storage file_path
  // under bucket whatsapp-hub-knowledge.
  content?: string;
}

const KNOWLEDGE_BUCKET = 'whatsapp-hub-knowledge';

const CHUNK_CHARS = 2000;   // ~500 tokens
const OVERLAP_CHARS = 200;  // ~50 tokens
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const EMBED_BATCH = 100;

function stripHtml(html: string): string {
  // Remove <script>/<style> blocks entirely, drop remaining tags, collapse
  // whitespace. Good enough for marketing copy / FAQ pages; NOT a parser.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Fallback de extração de PDF via OpenAI Responses API (input_file). Lê o PDF
// inteiro — inclusive escaneado (visão) — quando o unpdf falha ou não acha
// texto. Reusa a openai_api_key (já obrigatória p/ embeddings).
async function extractPdfViaOpenAI(openaiKey: string, bytes: Uint8Array): Promise<string> {
  const dataUrl = `data:application/pdf;base64,${bytesToBase64(bytes)}`;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_file', filename: 'document.pdf', file_data: dataUrl },
            {
              type: 'input_text',
              text: 'Extraia TODO o texto/conteúdo deste documento em texto corrido, em português do Brasil. Não resuma; transcreva integralmente.',
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI responses ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text: string =
    (typeof body.output_text === 'string' && body.output_text) ||
    ((body.output ?? []) as Array<{ content?: Array<{ text?: string }> }>)
      .flatMap((o) => (o.content ?? []).map((c) => c.text))
      .filter((t): t is string => Boolean(t))
      .join('\n');
  if (!text || !text.trim()) throw new Error('OpenAI não extraiu texto do PDF');
  return text.trim();
}

function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const end = Math.min(clean.length, cursor + CHUNK_CHARS);
    chunks.push(clean.slice(cursor, end).trim());
    if (end === clean.length) break;
    cursor = end - OVERLAP_CHARS;
  }
  return chunks.filter((c) => c.length > 0);
}

async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${err}`);
  }
  const body = await res.json();
  const rows = (body?.data ?? []) as Array<{ embedding: number[]; index: number }>;
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.embedding);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: Payload;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    if (!body.knowledge_base_id || !body.source_type || !body.content) {
      return jsonResponse(
        { ok: false, error: 'knowledge_base_id, source_type e content são obrigatórios.' },
        { status: 400 },
      );
    }

    const admin = getAdminClient();

    const { data: kbRow, error: kbErr } = await admin
      .from('knowledge_base')
      .select('id, org_id')
      .eq('id', body.knowledge_base_id)
      .maybeSingle();
    if (kbErr) return jsonResponse({ ok: false, error: kbErr.message }, { status: 500 });
    if (!kbRow) {
      return jsonResponse({ ok: false, error: 'Knowledge base não encontrada.' }, { status: 404 });
    }
    // Cross-check de org: a KB deve pertencer à org do caller.
    if ((kbRow as { org_id: string }).org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Knowledge base não encontrada.' }, { status: 404 });
    }

    const fail = async (msg: string, status = 500) => {
      // Loga o motivo real da falha (o front só vê status='error' na linha).
      console.error(JSON.stringify({
        event: 'process_knowledge_fail',
        knowledge_base_id: body.knowledge_base_id,
        source_type: body.source_type,
        status,
        message: msg,
      }));
      await admin
        .from('knowledge_base')
        .update({ status: 'error' })
        .eq('id', body.knowledge_base_id);
      return jsonResponse({ ok: false, error: msg }, { status });
    };

    const creds = await loadAppCredentials(caller.orgId);
    if (!creds.openai_api_key) {
      return fail('Credencial openai_api_key nao configurada. Acesse /settings/credentials.', 400);
    }

    // 1. Resolve plaintext.
    let plaintext = '';
    if (body.source_type === 'text') {
      plaintext = body.content.trim();
    } else if (body.source_type === 'url') {
      try {
        const urlRes = await fetch(body.content, {
          headers: { 'User-Agent': 'whatsapp-hub-knowledge/1.0' },
        });
        if (!urlRes.ok) {
          return fail(`Falha ao buscar URL: HTTP ${urlRes.status}`);
        }
        const html = await urlRes.text();
        plaintext = stripHtml(html);
      } catch (err) {
        return fail(`Falha ao buscar URL: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (body.source_type === 'pdf') {
      try {
        // body.content é o path do arquivo no bucket whatsapp-hub-knowledge.
        // Multi-tenant: os arquivos ficam sob o prefixo `<orgId>/`. Aceitamos
        // tanto o path já prefixado quanto o path relativo (prefixamos aqui).
        const storagePath = body.content.startsWith(`${caller.orgId}/`)
          ? body.content
          : `${caller.orgId}/${body.content}`;
        const { data: blob, error: dlErr } = await admin.storage
          .from(KNOWLEDGE_BUCKET)
          .download(storagePath);
        if (dlErr || !blob) {
          return fail(`Falha ao baixar PDF: ${dlErr?.message ?? 'desconhecido'}`);
        }
        const buffer = new Uint8Array(await blob.arrayBuffer());
        // 1ª tentativa: unpdf (rápido/grátis, PDF com camada de texto).
        try {
          const doc = await getDocumentProxy(buffer);
          const { text } = await extractText(doc, { mergePages: true });
          plaintext = (Array.isArray(text) ? text.join('\n') : text ?? '').trim();
        } catch (unpdfErr) {
          console.error(JSON.stringify({ event: 'unpdf_extract_error', error: String(unpdfErr) }));
          plaintext = '';
        }
        // Fallback: PDF escaneado (sem texto) ou unpdf falhou → OpenAI lê o PDF.
        if (plaintext.length < 20) {
          plaintext = await extractPdfViaOpenAI(creds.openai_api_key, buffer);
        }
        // Persist file_path on the KB row so the UI can link back to it.
        await admin
          .from('knowledge_base')
          .update({ file_path: storagePath, type: 'pdf' })
          .eq('id', body.knowledge_base_id);
      } catch (err) {
        return fail(`Falha ao extrair PDF: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      return fail('source_type inválido (use text, url ou pdf).', 400);
    }

    if (!plaintext) {
      return fail('Nenhum texto extraído do source.', 400);
    }

    // 2. Clear any previous chunks for idempotent re-processing.
    await admin
      .from('knowledge_chunks')
      .delete()
      .eq('knowledge_base_id', body.knowledge_base_id);

    // 3. Chunk.
    const chunks = chunkText(plaintext);
    if (chunks.length === 0) {
      return fail('Nenhum chunk gerado do texto.', 400);
    }

    // 4. Embed in batches.
    const rows: Array<{
      org_id: string;
      knowledge_base_id: string;
      content: string;
      embedding: number[];
      metadata: Record<string, unknown>;
    }> = [];

    try {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vectors = await embedBatch(creds.openai_api_key, batch);
        if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBED_DIMS)) {
          throw new Error('Embeddings retornados em shape inesperado.');
        }
        batch.forEach((chunkText, idx) => {
          rows.push({
            org_id: caller.orgId,
            knowledge_base_id: body.knowledge_base_id!,
            content: chunkText,
            embedding: vectors[idx],
            metadata: { index: i + idx, source_type: body.source_type },
          });
        });
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Falha ao gerar embeddings.');
    }

    // 5. Insert chunks + flip status.
    const { error: insErr } = await admin
      .from('knowledge_chunks')
      .insert(rows);
    if (insErr) return fail(`Falha ao gravar chunks: ${insErr.message}`);

    await admin
      .from('knowledge_base')
      .update({
        status: 'ready',
        file_size_bytes: new TextEncoder().encode(plaintext).length,
      })
      .eq('id', body.knowledge_base_id);

    return jsonResponse({
      ok: true,
      chunks: rows.length,
      total_chars: plaintext.length,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('process-knowledge error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
