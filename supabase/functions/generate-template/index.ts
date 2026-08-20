// ============================================================================
// generate-template
// ----------------------------------------------------------------------------
// Takes a brief objective + category from the admin and asks the configured
// LLM (env-supplied) to draft a complete WhatsApp message template. Returns a
// JSON payload the wizard pre-fills into the manual form so the admin can
// tweak copy before saving.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { callLLM, parseJsonContent, type LLMProvider } from '../_shared/llm.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

type Category = 'marketing' | 'utility' | 'authentication';
type HeaderType = 'none' | 'text' | 'image' | 'video' | 'document';

interface GeneratePayload {
  name?: string;
  category?: Category;
  language?: string;
  objective?: string;
  header_type?: HeaderType;
}

interface GeneratedTemplate {
  body: string;
  footer: string | null;
  header_content: string | null;
  buttons: Array<
    | { type: 'quick_reply'; text: string }
    | { type: 'url'; text: string; url: string }
    | { type: 'phone'; text: string; phone: string }
  >;
}

const SYSTEM_PROMPT = `Você é um especialista em copywriting para templates do WhatsApp Business. Os templates são submetidos à Meta (via Zernio) para aprovação, então cumpra rigorosamente as políticas da Meta:
 - Sem linguagem promocional agressiva (evite "CLIQUE AGORA!", all-caps exagerado).
 - Nunca prometa coisas ilegais ou irreais.
 - A Meta só aceita três categorias:
   - MARKETING: promoções, ofertas e novidades.
   - UTILITY: confirmações, notificações de conta, atualizações de pedido/transação.
   - AUTHENTICATION: códigos de verificação (OTP). Texto curto, sem links nem conteúdo promocional; a variável costuma ser o código.
 - "Atendimento/service" NÃO é categoria de template: resposta livre a uma conversa iniciada pelo cliente acontece dentro da janela de 24h, sem template.
 - NÃO use variáveis/placeholders ({{1}}, {{2}}...). O texto é fixo e igual para todos os contatos.
 - Em português brasileiro (pt_BR) a menos que o usuário peça outro idioma.
 - Responda SEMPRE em JSON estrito no schema fornecido — sem markdown, sem prosa adicional.`;

function buildUserPrompt(input: GeneratePayload): string {
  return [
    `Gere um template de WhatsApp com as características a seguir.`,
    `Categoria: ${input.category ?? 'utility'}`,
    `Idioma: ${input.language ?? 'pt_BR'}`,
    `Tipo de header: ${input.header_type ?? 'none'}`,
    ``,
    `Objetivo do template:`,
    `"""`,
    input.objective ?? 'Template genérico de atendimento.',
    `"""`,
    ``,
    `Responda com este JSON (sem comentários, sem markdown):`,
    `{`,
    `  "body": "texto do corpo, fixo e sem placeholders",`,
    `  "footer": "texto curto de rodapé ou null",`,
    `  "header_content": "texto do header se type='text', senão null",`,
    `  "buttons": [{"type":"quick_reply","text":"..."}] (máx 3 quick_reply OU 2 cta) ou []`,
    `}`,
  ].join('\n');
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: GeneratePayload;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    if (!body.objective || body.objective.trim().length < 10) {
      return jsonResponse(
        { ok: false, error: 'Descreva o objetivo do template (mínimo 10 caracteres).' },
        { status: 400 },
      );
    }

    const creds = await loadAppCredentials(caller.orgId);
    const provider: LLMProvider | null = creds.llm_provider;
    const apiKey = creds.llm_api_key;

    if (!provider || !apiKey) {
      return jsonResponse(
        {
          ok: false,
          error: 'Credenciais de LLM nao configuradas.',
          instrucao:
            'Acesse /settings/credentials e configure llm_provider e llm_api_key.',
        },
        { status: 400 },
      );
    }

    const llm = await callLLM({
      provider,
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(body),
      json: true,
      temperature: 0.8,
      maxTokens: 1200,
    });

    let parsed: GeneratedTemplate;
    try {
      parsed = parseJsonContent<GeneratedTemplate>(llm.content);
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: `Resposta do modelo não é JSON válido: ${err instanceof Error ? err.message : String(err)}`,
          raw: llm.content,
        },
        { status: 502 },
      );
    }

    return jsonResponse({ ok: true, template: parsed, model: llm.model });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('generate-template error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
