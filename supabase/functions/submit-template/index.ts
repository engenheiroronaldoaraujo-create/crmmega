// ============================================================================
// submit-template
// ----------------------------------------------------------------------------
// Admin ships a locally-drafted template to Meta for approval. We translate
// the row in whatsapp_hub.templates into Meta's component schema, POST it,
// and update the row with status='pending' + meta_template_id.
//
// Meta's template schema is component-oriented:
//   components: [
//     { type: 'HEADER', format: 'TEXT|IMAGE|VIDEO|DOCUMENT', text?, example? },
//     { type: 'BODY', text, example? },
//     { type: 'FOOTER', text },
//     { type: 'BUTTONS', buttons: [{type:'QUICK_REPLY',text},{type:'URL',text,url},{type:'PHONE_NUMBER',text,phone_number}] },
//   ]
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  ZernioError,
  createTemplate,
  type ZernioTemplateCategory,
} from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';

type HeaderType = 'none' | 'text' | 'image' | 'video' | 'document';

interface TemplateRow {
  id: string;
  org_id: string;
  name: string;
  category: 'marketing' | 'utility' | 'service' | 'authentication';
  language: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  header_type: HeaderType;
  header_content: string | null;
  body: string;
  footer: string | null;
  buttons: Array<
    | { type: 'quick_reply'; text: string }
    | { type: 'url'; text: string; url: string }
    | { type: 'phone'; text: string; phone: string }
  >;
  variables: Record<string, string>;
}

function countVariables(body: string): number {
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
  const uniq = new Set(matches.map((m) => m));
  return uniq.size;
}

// Componentes no formato do Zernio (POST /whatsapp/templates) — tudo lowercase:
// type header|body|footer|buttons; header.format text|image|video|document;
// button.type quick_reply|url|phone_number. Mídia no header vai como
// example.header_handle = [url público] (o Zernio baixa e sobe à Meta).
function buildMetaComponents(row: TemplateRow) {
  const components: Array<Record<string, unknown>> = [];

  if (row.header_type !== 'none') {
    const header: Record<string, unknown> = {
      type: 'header',
      format: row.header_type, // text | image | video | document
    };
    if (row.header_type === 'text') {
      if (row.header_content) header.text = row.header_content;
    } else if (row.header_content) {
      // header_content guarda a URL de exemplo da mídia (amostra p/ a Meta).
      header.example = { header_handle: [row.header_content] };
    }
    components.push(header);
  }

  const body: Record<string, unknown> = { type: 'body', text: row.body };
  // A Meta exige `example.body_text` (array de arrays) quando o corpo tem
  // variáveis. Usamos as descrições do usuário como amostra.
  const varCount = countVariables(row.body);
  if (varCount > 0) {
    const examples: string[] = [];
    for (let i = 1; i <= varCount; i++) {
      examples.push(row.variables?.[String(i)] || `exemplo ${i}`);
    }
    body.example = { body_text: [examples] };
  }
  components.push(body);

  if (row.footer) {
    components.push({ type: 'footer', text: row.footer });
  }

  if (row.buttons && row.buttons.length > 0) {
    components.push({
      type: 'buttons',
      buttons: row.buttons.map((b) => {
        if (b.type === 'quick_reply') return { type: 'quick_reply', text: b.text };
        if (b.type === 'url') return { type: 'url', text: b.text, url: b.url };
        if (b.type === 'phone') return { type: 'phone_number', text: b.text, phone_number: b.phone };
        return null;
      }).filter(Boolean),
    });
  }

  return components;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: { template_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    if (!body.template_id) {
      return jsonResponse({ ok: false, error: 'template_id ausente.' }, { status: 400 });
    }

    const admin = getAdminClient();

    const { data: row, error: rowErr } = await admin
      .from('templates')
      .select('*')
      .eq('id', body.template_id)
      .maybeSingle();
    if (rowErr) return jsonResponse({ ok: false, error: rowErr.message }, { status: 500 });
    if (!row) return jsonResponse({ ok: false, error: 'Template não encontrado.' }, { status: 404 });

    const template = row as TemplateRow;
    // Cross-check de org: o template deve pertencer à org do caller.
    if (template.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Template não encontrado.' }, { status: 404 });
    }

    const ctx = await loadOrgZernioContext(admin, caller.orgId);

    // Zernio repassa para a Meta, que so aceita MARKETING, UTILITY e
    // AUTHENTICATION. A categoria interna legada 'service' (atendimento livre)
    // nao e categoria de template — mapeada para UTILITY por compatibilidade.
    const ZERNIO_CATEGORY: Record<TemplateRow['category'], ZernioTemplateCategory> = {
      marketing: 'MARKETING',
      utility: 'UTILITY',
      authentication: 'AUTHENTICATION',
      service: 'UTILITY',
    };

    let result: { id: string | null; status: string | null };
    try {
      result = await createTemplate({
        apiKey: ctx.apiKey,
        accountId: ctx.accountId,
        name: template.name,
        category: ZERNIO_CATEGORY[template.category] ?? 'UTILITY',
        language: template.language,
        components: buildMetaComponents(template),
      });
    } catch (err) {
      // Mantem status='draft' para o admin corrigir e re-tentar.
      const msg = err instanceof Error ? err.message : 'Erro no Zernio';
      await admin
        .from('templates')
        .update({ meta_template_status: msg })
        .eq('id', template.id);
      const status = err instanceof ZernioError && err.status === 401 ? 401 : 200;
      return jsonResponse({ ok: false, error: msg }, { status });
    }

    const { error: upErr } = await admin
      .from('templates')
      .update({
        status: 'pending',
        meta_template_id: result.id,
        meta_template_status: result.status ?? 'PENDING',
        submitted_at: new Date().toISOString(),
      })
      .eq('id', template.id);

    if (upErr) return jsonResponse({ ok: false, error: upErr.message }, { status: 500 });

    return jsonResponse({
      ok: true,
      meta_template_id: result.id,
      meta_status: result.status ?? 'PENDING',
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('submit-template error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
