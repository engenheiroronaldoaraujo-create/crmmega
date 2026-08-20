// Shape of whatsapp_hub.templates for the frontend. Kept separate from
// types/db.ts so contact-related code doesn't pick up template changes.

// 'service' esta DEPRECADO (atendimento livre = resposta na janela de 24h, nao
// e categoria de template). Mantido por compatibilidade com linhas existentes;
// a UI de criacao passa a oferecer marketing/utility/authentication no Modulo 4.
export type TemplateCategory = 'marketing' | 'utility' | 'authentication' | 'service';
export type TemplateStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type HeaderType = 'none' | 'text' | 'image' | 'video' | 'document';

export type TemplateButton =
  | { type: 'quick_reply'; text: string }
  | { type: 'url'; text: string; url: string }
  | { type: 'phone'; text: string; phone: string };

export interface Template {
  id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  status: TemplateStatus;
  meta_template_id: string | null;
  meta_template_status: string | null;
  header_type: HeaderType;
  header_content: string | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  variables: Record<string, string>;
  ai_prompt: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

// Extracts unique variable indexes used in a body text (e.g. ["1", "2"]).
export function extractVariables(body: string): string[] {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g) ?? [];
  const seen = new Set<string>();
  for (const m of matches) {
    const idx = m.match(/\d+/)?.[0];
    if (idx) seen.add(idx);
  }
  return Array.from(seen).sort((a, b) => Number(a) - Number(b));
}
