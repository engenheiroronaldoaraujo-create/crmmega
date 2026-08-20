// ============================================================================
// process-ai-message
// ----------------------------------------------------------------------------
// Fired by the whatsapp_hub._on_inbound_message trigger every time a contact
// sends a message. The flow:
//
//   1. Load the message + conversation + agent config (singleton).
//   2. Bail if the AI should not answer (conversation.ai_paused, agent
//      config inactive, conversation closed, non-text content).
//   3. Embed the inbound text via OpenAI to get a query vector.
//   4. RPC to whatsapp_hub.knowledge_search for the top-5 similar chunks.
//   5. Build a system + user prompt with system_prompt + RAG + chat history.
//   6. Call the configured LLM (env-supplied).
//   7. POST the reply to Meta's session-messages endpoint.
//   8. Insert an outbound row with sender_type='ai' + meta_status.
//
// Any failure downstream is logged, persisted in the row, and NOT retried
// automatically here — future module can add a DLQ.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { callLLM, type LLMProvider } from '../_shared/llm.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { sendInboxWithResolve } from '../_shared/inbox-delivery.ts';

const EMBED_MODEL = 'text-embedding-3-small';
const TOP_K = 5;
const HISTORY_LIMIT = 20;

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: 'contact' | 'ai' | 'operator' | 'system';
  content_type: string;
  content: string | null;
  media_url: string | null;
  is_private_note: boolean;
  created_at: string;
}

interface ConversationRow {
  id: string;
  org_id: string;
  contact_id: string;
  status: 'ai_active' | 'human_active' | 'closed';
  ai_paused: boolean;
  channel: string | null;
  channel_id?: string | null;
  zernio_conversation_id: string | null;
  zernio_account_id?: string | null;
  provider?: string | null;
}

interface AgentConfig {
  system_prompt: string | null;
  temperature: number;
  max_tokens: number;
  is_active: boolean;
  active_whatsapp: boolean;
  active_instagram: boolean;
  auto_move_leads: boolean;
  model: string | null;
  timezone: string | null;
  variables: Record<string, string> | null;
}

// Módulo 8 — parâmetros do movimento automático de estágio pela IA.
const AUTO_MOVE_COOLDOWN_MS = 15 * 60 * 1000; // evita mover várias vezes em sequência
const AUTO_MOVE_MIN_CONFIDENCE = 0.7;         // só move com sinal claro

// ---------------------------------------------------------------------------
// Visão: descreve uma imagem recebida em texto (pt-BR), para a IA "entender".
// Usa a OpenAI (gpt-4o-mini com visão) com a openai_api_key — independente do
// provider de chat. Baixa os bytes e envia como data URL (a media_url pode não
// ser publicamente acessível pela OpenAI).
// ---------------------------------------------------------------------------
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function describeImage(openaiKey: string, imageUrl: string): Promise<string> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`download imagem ${imgRes.status}`);
  const mime = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 350,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Descreva esta imagem em português do Brasil, de forma objetiva. Se houver texto na imagem, transcreva-o integralmente. Máximo 4 frases.',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI vision ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('visão retornou vazio');
  return `[imagem] ${text.trim()}`;
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface AutoMoveDeps {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  orgId: string;
  contactId: string;
  transcript: string;
}

// Avalia se o lead avançou de estágio no funil comercial e, com sinal claro,
// move o deal e registra em lead_stage_history (moved_by='ia'). Respeita
// cooldown e só considera estágios COM ai_criteria. Nunca lança — falhas viram
// { moved:false }.
async function maybeAutoMoveLead(
  admin: ReturnType<typeof getAdminClient>,
  d: AutoMoveDeps,
): Promise<{ moved: boolean; skipped?: string; to?: string; reason?: string }> {
  // 1. Deal aberto no funil comercial deste contato.
  const { data: dealRows } = await admin
    .from('deals')
    .select('id, stage_id, pipeline_id, pipelines:pipeline_id(kind)')
    .eq('org_id', d.orgId)
    .eq('contact_id', d.contactId)
    .eq('status', 'open')
    .order('updated_at', { ascending: false });
  const deal = ((dealRows ?? []) as Array<{
    id: string; stage_id: string | null; pipeline_id: string | null; pipelines: { kind?: string } | null;
  }>).find((x) => (x.pipelines?.kind ?? 'comercial') === 'comercial');
  if (!deal || !deal.pipeline_id) return { moved: false, skipped: 'no open commercial deal' };

  // 2. Estágios do funil; candidatos são os que têm ai_criteria.
  const { data: stageRows } = await admin
    .from('stages')
    .select('id, name, position, is_won, is_lost, ai_criteria')
    .eq('pipeline_id', deal.pipeline_id)
    .order('position');
  const stages = (stageRows ?? []) as Array<{
    id: string; name: string; is_won: boolean; is_lost: boolean; ai_criteria: string | null;
  }>;
  const candidates = stages.filter((s) => s.ai_criteria && s.ai_criteria.trim());
  if (candidates.length === 0) return { moved: false, skipped: 'no ai_criteria on stages' };

  // 3. Cooldown: sem outro movimento da IA neste deal na janela recente.
  const { data: lastMove } = await admin
    .from('lead_stage_history')
    .select('created_at')
    .eq('deal_id', deal.id)
    .eq('moved_by', 'ia')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastMove && Date.now() - new Date((lastMove as { created_at: string }).created_at).getTime() < AUTO_MOVE_COOLDOWN_MS) {
    return { moved: false, skipped: 'cooldown' };
  }

  // 4. Classificação via LLM (JSON estrito, temperatura 0).
  const currentStage = stages.find((s) => s.id === deal.stage_id);
  const stageList = candidates.map((s) => `- id=${s.id} | ${s.name}: ${s.ai_criteria}`).join('\n');
  const sys =
    'Você classifica em qual estágio de funil um lead está, a partir da conversa. ' +
    'Responda SOMENTE com JSON válido, sem texto fora do JSON.';
  const user =
    `Estágio atual do lead: ${currentStage?.name ?? 'desconhecido'} (id=${deal.stage_id ?? 'null'}).\n\n` +
    `Estágios candidatos (escolha só entre estes ids):\n${stageList}\n\n` +
    `Conversa (cronológica):\n${d.transcript}\n\n` +
    `Regras: escolha o estágio cujo critério esteja CLARAMENTE satisfeito pela conversa. ` +
    `Se ambíguo ou sem sinal claro, NÃO mova (retorne stage_id null). Nunca invente ids.\n` +
    `Responda JSON: {"stage_id": "<id ou null>", "confidence": <0..1>, "reason": "<motivo curto>"}`;

  let content: string;
  try {
    const res = await callLLM({
      provider: d.provider, apiKey: d.apiKey, model: d.model,
      systemPrompt: sys, userPrompt: user, temperature: 0, maxTokens: 200,
    });
    content = res.content;
  } catch (err) {
    return { moved: false, skipped: `llm: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = parseJsonLoose(content);
  if (!parsed) return { moved: false, skipped: 'parse' };
  const stageId = typeof parsed.stage_id === 'string' ? parsed.stage_id : null;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  if (!stageId || stageId === deal.stage_id) return { moved: false, skipped: 'no change' };
  if (!candidates.some((s) => s.id === stageId)) return { moved: false, skipped: 'invalid stage id' };
  if (confidence < AUTO_MOVE_MIN_CONFIDENCE) return { moved: false, skipped: `low confidence ${confidence}` };

  // 5. Move o deal + registra no histórico. status acompanha estágio ganho/perdido.
  const target = stages.find((s) => s.id === stageId)!;
  const nextStatus = target.is_won ? 'won' : target.is_lost ? 'lost' : 'open';
  await admin.from('deals').update({ stage_id: stageId, status: nextStatus }).eq('id', deal.id);
  await admin.from('lead_stage_history').insert({
    org_id: d.orgId,
    deal_id: deal.id,
    from_stage_id: deal.stage_id,
    to_stage_id: stageId,
    moved_by: 'ia',
    reason: reason.slice(0, 300),
  });
  return { moved: true, to: stageId, reason };
}

// ---- Horário de atendimento → variáveis automáticas -----------------------
// A IA recebe o horário atual, se está dentro do expediente e a mensagem de
// fora-do-horário (já preenchida) como variáveis. O prompt decide usá-las
// (tipicamente só no handoff fora do horário). Não há gate no código.

type DaySlot = { enabled?: boolean; start?: string; end?: string };
const DAY_LABELS: Record<string, string> = {
  mon: 'segunda', tue: 'terça', wed: 'quarta', thu: 'quinta',
  fri: 'sexta', sat: 'sábado', sun: 'domingo',
};
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND = ['sat', 'sun'];
const SHORT_TO_KEY: Record<string, string> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
};

function nowInTz(tz: string): { key: string; hhmm: string; label: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
  }
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const key = SHORT_TO_KEY[wd] ?? 'mon';
  return { key, hhmm: `${hh}:${mm}`, label: DAY_LABELS[key] };
}

function slotOf(bh: unknown, key: string): DaySlot {
  return (bh && typeof bh === 'object' ? (bh as Record<string, DaySlot>)[key] : null) ?? {};
}

function buildScheduleVars(
  tz: string,
  businessHours: unknown,
  outMsg: string | null,
): Record<string, string> {
  const { key, hhmm, label } = nowInTz(tz);
  const today = slotOf(businessHours, key);
  const within =
    Boolean(today.enabled) &&
    typeof today.start === 'string' && typeof today.end === 'string' &&
    today.start <= hhmm && hhmm <= today.end;

  const wdOn = WEEKDAYS.filter((k) => slotOf(businessHours, k).enabled);
  const weOn = WEEKEND.filter((k) => slotOf(businessHours, k).enabled);
  const wkFirst = wdOn.length ? slotOf(businessHours, wdOn[0]) : {};
  const weFirst = weOn.length ? slotOf(businessHours, weOn[0]) : {};

  const filled = (outMsg ?? '')
    .replace(/\{dia_inicial\}/g, wdOn.length ? DAY_LABELS[wdOn[0]] : '')
    .replace(/\{dia_final\}/g, wdOn.length ? DAY_LABELS[wdOn[wdOn.length - 1]] : '')
    .replace(/\{horario_inicial_week\}/g, wkFirst.start ?? '')
    .replace(/\{horario_final_week\}/g, wkFirst.end ?? '')
    .replace(/\{final_de_semana\}/g, weOn.map((k) => DAY_LABELS[k]).join(' e '))
    .replace(/\{horario_inicial_weekend\}/g, weFirst.start ?? '')
    .replace(/\{horario_final_weekend\}/g, weFirst.end ?? '');

  const readable = [
    wdOn.length ? `${DAY_LABELS[wdOn[0]]} a ${DAY_LABELS[wdOn[wdOn.length - 1]]} ${wkFirst.start}–${wkFirst.end}` : '',
    weOn.length ? `${weOn.map((k) => DAY_LABELS[k]).join(' e ')} ${weFirst.start}–${weFirst.end}` : '',
  ].filter(Boolean).join('; ');

  return {
    agora: `${label}, ${hhmm}`,
    dentro_do_horario: within ? 'sim' : 'não',
    horario_atendimento: readable,
    mensagem_fora_horario: filled.trim(),
  };
}

// Substitui {chave} pelos valores das variáveis do agente. Chaves desconhecidas
// ficam intactas (para não quebrar texto que use {} por outros motivos).
function applyVariables(prompt: string, vars: Record<string, string> | null): string {
  if (!vars) return prompt;
  return prompt.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole,
  );
}

// Detecta o marcador [HANDOFF] (linha própria, case-insensitive) e devolve o
// texto sem ele. A ferramenta nunca envia "[HANDOFF]" ao contato.
function extractHandoff(reply: string): { text: string; handoff: boolean } {
  const handoff = /(^|\n)\s*\[handoff\]\s*(\n|$)/i.test(reply);
  const text = reply.replace(/(^|\n)\s*\[handoff\]\s*(?=\n|$)/gi, '').trim();
  return { text, handoff };
}

// Detecta marcadores [MEDIA:rotulo] (case-insensitive) e devolve o texto sem
// eles + a lista de rótulos. A ferramenta envia as mídias correspondentes.
function extractMedia(reply: string): { text: string; labels: string[] } {
  const labels: string[] = [];
  const text = reply
    .replace(/\[media:\s*([a-z0-9_-]+)\s*\]/gi, (_w, label: string) => {
      labels.push(String(label).toLowerCase());
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { text, labels };
}

async function embed(openaiKey: string, text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body?.data?.[0]?.embedding ?? [];
}

function buildUserPrompt(history: MessageRow[], ragChunks: string[], inbound: string): string {
  const historyText = history
    .filter((m) => !m.is_private_note && m.content)
    .map((m) => {
      const who =
        m.sender_type === 'contact'
          ? 'Cliente'
          : m.sender_type === 'ai'
            ? 'Assistente'
            : m.sender_type === 'operator'
              ? 'Atendente humano'
              : 'Sistema';
      return `[${who}] ${m.content}`;
    })
    .join('\n');

  const ragBlock = ragChunks.length
    ? `\n\nContexto relevante da base de conhecimento:\n${ragChunks.map((c, i) => `(${i + 1}) ${c}`).join('\n\n')}`
    : '';

  return [
    `Histórico da conversa (cronológico):\n${historyText}`,
    ragBlock,
    `\nMensagem atual do cliente:\n"${inbound}"`,
    `\nResponda em português brasileiro, de forma objetiva, baseado no contexto. Se não souber, diga que vai chamar um humano.`,
  ].join('\n');
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

  // 1. Load triggering message.
  const { data: msgRow, error: msgErr } = await admin
    .from('messages')
    .select('id, conversation_id, direction, sender_type, content_type, content, media_url, is_private_note, created_at')
    .eq('id', body.message_id)
    .maybeSingle();
  if (msgErr || !msgRow) {
    return jsonResponse({ ok: false, error: 'Mensagem não encontrada.' }, { status: 404 });
  }
  const message = msgRow as MessageRow;

  // Guard: this function is only meant to run on inbound messages from a contact.
  // Mídia (áudio/imagem) é convertida em texto mais abaixo (após o gate da IA e
  // as credenciais): áudio pelo transcribe-audio, imagem por visão aqui mesmo.
  if (message.direction !== 'inbound' || message.sender_type !== 'contact') {
    return jsonResponse({ ok: true, skipped: 'not an inbound contact message' });
  }

  // 2. Load conversation (carrega org_id — tudo daqui pra frente é da org da
  //    conversa: credenciais, config do agente, RAG, business hours).
  const { data: convRow } = await admin
    .from('conversations')
    .select('id, org_id, contact_id, status, ai_paused, channel, channel_id, zernio_conversation_id, zernio_account_id, provider')
    .eq('id', message.conversation_id)
    .maybeSingle();
  if (!convRow) {
    return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
  }
  const conversation = convRow as ConversationRow;
  const orgId = conversation.org_id;

  // Org arquivada: não responde (sai silenciosamente).
  const { data: orgRow } = await admin
    .from('organizations')
    .select('status')
    .eq('id', orgId)
    .maybeSingle();
  if ((orgRow as { status?: string } | null)?.status !== 'active') {
    return jsonResponse({ ok: true, skipped: 'org not active' });
  }

  // Config do agente DA ORG (não há mais singleton global).
  const { data: agentRow } = await admin
    .from('ai_agent_config')
    .select('system_prompt, temperature, max_tokens, is_active, active_whatsapp, active_instagram, auto_move_leads, model, timezone, variables')
    .eq('org_id', orgId)
    .maybeSingle();
  const agent = (agentRow as AgentConfig | null) ?? null;

  if (conversation.status === 'closed') {
    return jsonResponse({ ok: true, skipped: 'conversation closed' });
  }
  if (conversation.ai_paused) {
    return jsonResponse({ ok: true, skipped: 'ai paused' });
  }

  // Gate único: a IA só responde se existe agente, ele está ativo globalmente,
  // ativo para o canal desta conversa E habilitado no NÚMERO da conversa
  // (channels.ai_enabled — número pessoal de vendedor costuma desligar a IA).
  // Em QUALQUER caso em que a IA não vá responder (agente inexistente,
  // is_active=false, canal ou número desligado), a conversa vai direto para
  // atendimento humano — status human_active + ai_paused true. Esse flip
  // false→true dispara os triggers _on_handoff_autoassign (round-robin
  // org-scoped, respeitando fila/online/auto_assign_enabled) e
  // _on_handoff_notify (só o responsável, quando há um). É reversível: o
  // operador pode retomar a IA.
  const channel = conversation.channel === 'instagram' ? 'instagram' : 'whatsapp';
  const channelEnabled =
    channel === 'instagram'
      ? (agent?.active_instagram ?? false)
      : (agent?.active_whatsapp ?? true);
  // IA por número: sem channel_id (conversa legada/Instagram) = habilitado.
  let numberAiEnabled = true;
  if (conversation.channel_id) {
    const { data: chRow } = await admin
      .from('channels')
      .select('ai_enabled')
      .eq('id', conversation.channel_id)
      .maybeSingle();
    numberAiEnabled = (chRow as { ai_enabled?: boolean } | null)?.ai_enabled ?? true;
  }
  if (!agent || agent.is_active === false || !channelEnabled || !numberAiEnabled) {
    await admin
      .from('conversations')
      .update({ status: 'human_active', ai_paused: true, last_message_at: new Date().toISOString() })
      .eq('id', conversation.id);
    const reason = !agent || agent.is_active === false
      ? 'ai agent disabled'
      : !channelEnabled
        ? `ai disabled for channel ${channel}`
        : 'ai disabled for this number';
    return jsonResponse({ ok: true, skipped: reason, routed_to_human: true });
  }

  // 3. Credentials (da org da conversa).
  const creds = await loadAppCredentials(orgId);
  if (!creds.openai_api_key) {
    return jsonResponse({ ok: false, error: 'Credencial openai_api_key nao configurada. Acesse /settings/credentials.' }, { status: 400 });
  }
  const provider: LLMProvider | null = creds.llm_provider;
  const llmKey = creds.llm_api_key;
  if (!provider || !llmKey) {
    return jsonResponse({ ok: false, error: 'Credenciais llm_provider/llm_api_key nao configuradas. Acesse /settings/credentials.' }, { status: 400 });
  }

  // Mídia → texto. A IA só entende texto: imagem é descrita por visão (OpenAI,
  // reusa a openai_api_key mesmo se o chat usa Claude/Gemini) e a descrição é
  // persistida no content; áudio já vem transcrito pelo transcribe-audio (que
  // re-dispara este pipeline). Sem conteúdo textual ainda → aguarda/pula.
  if (message.content_type !== 'text' && !message.content && message.media_url) {
    if (message.content_type === 'image') {
      try {
        const desc = await describeImage(creds.openai_api_key, message.media_url);
        message.content = desc;
        await admin.from('messages').update({ content: desc }).eq('id', message.id);
      } catch (err) {
        console.error(JSON.stringify({ event: 'describe_image_error', message_id: message.id, error: String(err) }));
      }
    }
  }
  if (!message.content) {
    return jsonResponse({ ok: true, skipped: `sem conteúdo textual (content_type=${message.content_type})` });
  }

  // 4. Embed the inbound text.
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(creds.openai_api_key, message.content);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `embed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // 5. Top-K RAG chunks (cosine similarity). Empty array is fine — the
  //    agent still answers, just without retrieved context.
  const { data: ragRows } = await admin.rpc('knowledge_search', {
    p_query_embedding: queryEmbedding,
    p_top_k: TOP_K,
    p_org_id: orgId,
  });
  const ragChunks = ((ragRows ?? []) as Array<{ content: string; similarity: number }>)
    .map((r) => r.content);

  // 6. History — last N messages in this conversation, oldest first.
  const { data: historyRows } = await admin
    .from('messages')
    .select('id, conversation_id, direction, sender_type, content_type, content, is_private_note, created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = ((historyRows ?? []) as MessageRow[]).reverse();

  // 7. LLM call. Resolve as variáveis {chave} do prompt e injeta o nome do
  //    contato quando disponível.
  const { data: contactNameRow } = await admin
    .from('contacts')
    .select('name')
    .eq('id', conversation.contact_id)
    .maybeSingle();
  const firstName = ((contactNameRow as { name?: string } | null)?.name ?? '').trim().split(/\s+/)[0] || '';

  // Variáveis automáticas de horário (horário atual, dentro/fora do expediente,
  // mensagem de fora-do-horário já preenchida) — o prompt decide quando usar.
  const { data: settingsRow } = await admin
    .from('app_settings')
    .select('business_hours, out_of_hours_message')
    .eq('org_id', orgId)
    .maybeSingle();
  const scheduleVars = buildScheduleVars(
    agent.timezone ?? 'America/Sao_Paulo',
    (settingsRow as { business_hours?: unknown } | null)?.business_hours,
    (settingsRow as { out_of_hours_message?: string | null } | null)?.out_of_hours_message ?? null,
  );

  // Mídias do agente: lista para o prompt ({midias_disponiveis}) e mapa
  // rótulo→mídia para resolver os marcadores [MEDIA:rotulo].
  const { data: mediaRows } = await admin
    .from('ai_agent_media')
    .select('label, media_url, content_type, usage_note')
    .eq('org_id', orgId);
  const mediaList = (mediaRows ?? []) as Array<{
    label: string; media_url: string; content_type: string; usage_note: string | null;
  }>;
  const mediaByLabel = new Map(mediaList.map((m) => [m.label.toLowerCase(), m]));
  const midiasDisponiveis = mediaList.length
    ? mediaList
        .map((m) => `[MEDIA:${m.label}] (${m.content_type})${m.usage_note ? ' — ' + m.usage_note : ''}`)
        .join('; ')
    : 'nenhuma';

  const vars = {
    ...(agent.variables ?? {}),
    nome_do_contato: firstName,
    ...scheduleVars,
    midias_disponiveis: midiasDisponiveis,
  };

  const basePrompt =
    agent.system_prompt?.trim() ||
    'Você é um assistente de atendimento via WhatsApp. Responda em português brasileiro, de forma objetiva e educada.';
  const systemPrompt = applyVariables(basePrompt, vars);
  const userPrompt = buildUserPrompt(history, ragChunks, message.content);

  let reply: string;
  try {
    const result = await callLLM({
      provider,
      apiKey: llmKey,
      model: agent.model ?? undefined,
      systemPrompt,
      userPrompt,
      temperature: agent.temperature ?? 0.7,
      maxTokens: agent.max_tokens ?? 1000,
    });
    reply = result.content.trim();
    if (!reply) throw new Error('LLM retornou resposta vazia.');
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `llm: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Marcadores: [MEDIA:rotulo] (envia mídias) e [HANDOFF] (transfere). Remove
  // ambos do texto antes de enviar.
  const mediaExtract = extractMedia(reply);
  const { text: cleanedText, handoff } = extractHandoff(mediaExtract.text);
  const mediaToSend = mediaExtract.labels
    .map((l) => mediaByLabel.get(l))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  // Texto: o que sobrou; se vazio mas houve handoff, usa despedida; se vazio e
  // só houve mídia, não envia texto.
  const textBody = cleanedText.trim()
    ? cleanedText.trim()
    : handoff
      ? 'Perfeito! Vou te transferir para um especialista do time aqui mesmo nesta conversa. 🙌'
      : '';

  // Handoff: pausa a IA e marca a conversa p/ atendimento humano (o trigger
  // _on_handoff_notify notifica os operadores quando ai_paused vira true).
  await admin
    .from('conversations')
    .update(
      handoff
        ? { last_message_at: new Date().toISOString(), status: 'human_active', ai_paused: true }
        : { last_message_at: new Date().toISOString() },
    )
    .eq('id', conversation.id);

  // 9. Envia pelo canal da conversa (Zernio/UAZAPI). O helper resolve o contexto
  //    a partir do org_id + channel_id e auto-corrige o id salvo. Identidade do
  //    contato: phone p/ WhatsApp, instagram_id p/ Instagram.
  const { data: contactRow } = await admin
    .from('contacts')
    .select('phone, instagram_id')
    .eq('id', conversation.contact_id)
    .maybeSingle();
  const contact = (contactRow as { phone?: string; instagram_id?: string } | null) ?? {};
  const target = {
    conversationRowId: conversation.id,
    orgId,
    channel: channel as 'whatsapp' | 'instagram',
    phone: contact.phone ?? null,
    instagramId: contact.instagram_id ?? null,
    storedZernioConversationId: conversation.zernio_conversation_id,
    channelId: conversation.channel_id ?? null,
    zernioAccountId: conversation.zernio_account_id ?? null,
    provider: conversation.provider ?? null,
  };

  // Texto (persiste + envia) — só se houver.
  let textMessageId: string | null = null;
  let textError: string | null = null;
  if (textBody) {
    const { data: ins } = await admin
      .from('messages')
      .insert({ org_id: orgId, conversation_id: conversation.id, direction: 'outbound', sender_type: 'ai', content_type: 'text', content: textBody, is_private_note: false })
      .select('id').single();
    const outboundId = (ins as { id: string } | null)?.id ?? null;
    try {
      textMessageId = await sendInboxWithResolve(admin, target, { text: textBody });
      if (outboundId) await admin.from('messages').update({ meta_status: 'sent', zernio_message_id: textMessageId }).eq('id', outboundId);
    } catch (err) {
      textError = err instanceof Error ? err.message : 'Erro ao enviar via Zernio.';
      if (outboundId) await admin.from('messages').update({ meta_status: 'failed' }).eq('id', outboundId);
    }
  }

  // Mídias (cada uma persiste + envia com attachmentUrl = URL pública).
  let mediaSent = 0;
  for (const m of mediaToSend) {
    const attachmentType =
      (['image', 'video', 'audio'].includes(m.content_type) ? m.content_type : 'file') as 'image' | 'video' | 'audio' | 'file';
    const { data: mIns } = await admin
      .from('messages')
      .insert({ org_id: orgId, conversation_id: conversation.id, direction: 'outbound', sender_type: 'ai', content_type: m.content_type, content: null, media_url: m.media_url, is_private_note: false })
      .select('id').single();
    const mId = (mIns as { id: string } | null)?.id ?? null;
    try {
      const mMsgId = await sendInboxWithResolve(admin, target, { attachmentUrl: m.media_url, attachmentType });
      if (mId) await admin.from('messages').update({ meta_status: 'sent', zernio_message_id: mMsgId }).eq('id', mId);
      mediaSent++;
    } catch (_err) {
      if (mId) await admin.from('messages').update({ meta_status: 'failed' }).eq('id', mId);
    }
  }

  await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id);

  // Módulo 8: IA move o lead pelo funil (com sinal claro). Só quando o toggle
  // está ligado; o gate de canal já barrou canais desligados acima. Nunca
  // interrompe o fluxo principal.
  let autoMove: Awaited<ReturnType<typeof maybeAutoMoveLead>> = { moved: false, skipped: 'disabled' };
  if (agent.auto_move_leads !== false) {
    try {
      const transcript = history
        .filter((m) => !m.is_private_note && m.content)
        .map((m) => {
          const who = m.sender_type === 'contact' ? 'Cliente' : m.sender_type === 'ai' ? 'Assistente' : m.sender_type === 'operator' ? 'Atendente' : 'Sistema';
          return `[${who}] ${m.content}`;
        })
        .join('\n');
      autoMove = await maybeAutoMoveLead(admin, {
        provider,
        apiKey: llmKey,
        model: agent.model ?? undefined,
        orgId,
        contactId: conversation.contact_id,
        transcript,
      });
    } catch (err) {
      autoMove = { moved: false, skipped: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return jsonResponse({
    ok: true,
    sent_to_zernio: !textError,
    zernio_message_id: textMessageId,
    media_sent: mediaSent,
    rag_chunks: ragChunks.length,
    handoff,
    auto_move: autoMove,
    zernio_error: textError ?? undefined,
  });
});
