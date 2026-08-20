// Thin provider-dispatch layer so Edge Functions can ask for a JSON-shaped
// completion without caring which LLM vendor the tenant selected.
//
// Each branch returns raw `content` (string). The caller parses JSON if it
// asked for JSON mode; if the model slipped in markdown fences we strip them.

export type LLMProvider = 'openai' | 'claude' | 'gemini';

export interface LLMCallInput {
  provider: LLMProvider;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  // Modelo escolhido pelo usuário (atualmente só usado no provider OpenAI;
  // claude/gemini mantêm o default da casa).
  model?: string;
}

export interface LLMCallResult {
  content: string;
  model: string;
}

export async function callLLM(input: LLMCallInput): Promise<LLMCallResult> {
  switch (input.provider) {
    case 'openai':
      return callOpenAI(input);
    case 'claude':
      return callClaude(input);
    case 'gemini':
      return callGemini(input);
  }
}

async function callOpenAI(input: LLMCallInput): Promise<LLMCallResult> {
  const model = input.model?.trim() || 'gpt-4.1-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens ?? 1500,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      ...(input.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  const body = await res.json();
  return { content: body.choices?.[0]?.message?.content ?? '', model };
}

async function callClaude(input: LLMCallInput): Promise<LLMCallResult> {
  // Defaults to the current best all-rounder per Anthropic's lineup.
  const model = 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 1500,
      temperature: input.temperature ?? 0.7,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude ${res.status}: ${err}`);
  }
  const body = await res.json();
  // Claude returns an array of content blocks; the first text block is what we want.
  const text =
    Array.isArray(body.content)
      ? body.content.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      : '';
  return { content: text, model };
}

async function callGemini(input: LLMCallInput): Promise<LLMCallResult> {
  const model = 'gemini-1.5-flash-latest';
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
      generationConfig: {
        temperature: input.temperature ?? 0.7,
        maxOutputTokens: input.maxTokens ?? 1500,
        ...(input.json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }
  const body = await res.json();
  const text =
    body.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  return { content: text, model };
}

/**
 * Some models wrap JSON in ```json fences or prose; strip that and parse.
 */
export function parseJsonContent<T>(raw: string): T {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) cleaned = fence[1].trim();
  return JSON.parse(cleaned) as T;
}
