import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { useTemplates } from '@/hooks/useTemplates';
import {
  extractVariables,
  type HeaderType,
  type Template,
  type TemplateButton,
  type TemplateCategory,
} from '@/types/templates';

interface TemplateFormDialogProps {
  open: boolean;
  onClose: () => void;
  template?: Template | null;
  onSaved?: () => void;
}

const NAME_RULE = /^[a-z0-9_]+$/;

// Categorias aceitas pela Meta/Zernio. 'service' (atendimento) NAO e categoria
// de template — atendimento livre e resposta dentro da janela de 24h.
const CATEGORIES: { value: Exclude<TemplateCategory, 'service'>; label: string; hint: string }[] = [
  { value: 'marketing', label: 'Marketing', hint: 'Promoções, ofertas' },
  { value: 'utility', label: 'Utility', hint: 'Confirmações, updates' },
  { value: 'authentication', label: 'Authentication', hint: 'Códigos de verificação (OTP)' },
];

const HEADER_TYPES: { value: HeaderType; label: string }[] = [
  { value: 'none', label: 'Nenhum' },
  { value: 'text', label: 'Texto' },
  { value: 'image', label: 'Imagem' },
  { value: 'video', label: 'Vídeo' },
  { value: 'document', label: 'Documento' },
];

export function TemplateFormDialog({
  open,
  onClose,
  template,
  onSaved,
}: TemplateFormDialogProps) {
  const { create, update } = useTemplates();

  const [name, setName] = useState('');
  const [category, setCategory] = useState<TemplateCategory>('utility');
  const [language, setLanguage] = useState('pt_BR');
  const [headerType, setHeaderType] = useState<HeaderType>('none');
  const [headerContent, setHeaderContent] = useState('');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<TemplateButton[]>([]);
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  const isEdit = Boolean(template);
  const detectedVars = useMemo(() => extractVariables(body), [body]);
  // Exemplos por variável ({{1}} → texto de amostra exigido pela Meta na aprovação).
  const [varExamples, setVarExamples] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setVarExamples((template?.variables as Record<string, string> | null) ?? {});
    // 'service' esta deprecada: ao editar um template legado, cai em 'utility'
    // (mesma categoria para a qual submit-template ja mapeava 'service').
    setCategory(template?.category === 'service' ? 'utility' : (template?.category ?? 'utility'));
    setLanguage(template?.language ?? 'pt_BR');
    setHeaderType(template?.header_type ?? 'none');
    setHeaderContent(template?.header_content ?? '');
    setBody(template?.body ?? '');
    setFooter(template?.footer ?? '');
    setButtons((template?.buttons ?? []) as TemplateButton[]);
    setAiPrompt(template?.ai_prompt ?? '');
  }, [open, template]);

  const handleGenerate = async () => {
    if (aiPrompt.trim().length < 10) {
      toast.error('Descreva o objetivo do template (mínimo 10 caracteres).');
      return;
    }
    setGenerating(true);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('generate-template', {
      body: {
        category,
        language,
        header_type: headerType,
        objective: aiPrompt,
      },
    });
    setGenerating(false);

    if (error || !data?.ok) {
      toast.error('Falha na geração', {
        description: data?.error ?? error?.message ?? 'Erro desconhecido',
      });
      return;
    }
    const gen = data.template as {
      body: string;
      footer: string | null;
      header_content: string | null;
      buttons: TemplateButton[];
    };
    setBody(gen.body ?? '');
    setFooter(gen.footer ?? '');
    if (headerType === 'text') setHeaderContent(gen.header_content ?? '');
    setButtons(gen.buttons ?? []);
    toast.success(`Gerado (${data.model}) — revise antes de salvar.`);
  };

  const addButton = (kind: TemplateButton['type']) => {
    if (kind === 'quick_reply') {
      const quickReplyCount = buttons.filter((b) => b.type === 'quick_reply').length;
      if (quickReplyCount >= 3) {
        toast.error('Máximo 3 botões de quick_reply por template.');
        return;
      }
      setButtons((prev) => [...prev, { type: 'quick_reply', text: '' }]);
    } else {
      const ctaCount = buttons.filter((b) => b.type !== 'quick_reply').length;
      if (ctaCount >= 2) {
        toast.error('Máximo 2 botões de CTA por template.');
        return;
      }
      if (kind === 'url') setButtons((prev) => [...prev, { type: 'url', text: '', url: '' }]);
      if (kind === 'phone') setButtons((prev) => [...prev, { type: 'phone', text: '', phone: '' }]);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!NAME_RULE.test(name)) {
      toast.error('Nome inválido', {
        description: 'Use apenas letras minúsculas, números e underscore.',
      });
      return;
    }
    if (body.trim().length === 0) {
      toast.error('Body não pode ficar vazio.');
      return;
    }
    // Variáveis são permitidas ({{1}}, {{2}}…) — a Meta exige um exemplo por
    // variável para aprovar o template.
    if (detectedVars.some((i) => !(varExamples[String(i)] ?? '').trim())) {
      toast.error('Preencha o exemplo de cada variável', {
        description: 'A Meta exige um texto de amostra por variável para aprovação.',
      });
      return;
    }

    setSaving(true);
    const payload = {
      name,
      category,
      language,
      header_type: headerType,
      // header_content guarda o texto (header text) ou a URL de exemplo da
      // mídia (image/video/document). Vazio só quando não há header.
      header_content: headerType === 'none' ? null : headerContent.trim() || null,
      body,
      footer: footer.trim() || null,
      buttons,
      variables: Object.fromEntries(
        detectedVars.map((i) => [String(i), (varExamples[String(i)] ?? '').trim()]),
      ),
      ai_prompt: aiPrompt.trim() || null,
    };
    if (isEdit && template) {
      await update(template.id, payload);
    } else {
      await create(payload);
    }
    setSaving(false);
    toast.success(isEdit ? 'Template atualizado.' : 'Template salvo como draft.');
    onSaved?.();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Editar template' : 'Novo template'}
      widthClass="max-w-4xl"
      opaque
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* -- IA Generator -- */}
        <div className="rounded-lg border border-[rgba(139,92,246,0.25)] bg-[rgba(139,92,246,0.05)] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#A78BFA]" />
            <span className="text-sm font-semibold">Gerar com IA</span>
            <span className="text-xs text-[var(--color-text-secondary)] opacity-70">
              preenche body/footer/buttons com base no objetivo
            </span>
          </div>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Ex: Confirmação de pedido no e-commerce, com nome do cliente e número do pedido"
            rows={2}
            className="w-full rounded-lg border border-[rgba(139,92,246,0.2)] bg-white/[0.03] px-4 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[#A78BFA]"
            disabled={generating || saving}
          />
          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleGenerate}
              disabled={generating || saving}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Gerando...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Gerar
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="tpl_name">Nome (slug)</Label>
            <Input
              id="tpl_name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              placeholder="boas_vindas_cliente"
              disabled={saving || isEdit}
              required
            />
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              a-z, 0-9, underscore. Não pode mudar depois de submeter à Meta.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl_cat">Categoria</Label>
            <select
              id="tpl_cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as TemplateCategory)}
              disabled={saving}
              className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              {CATEGORIES.find((c) => c.value === category)?.hint}
            </p>
            <p className="text-[11px] leading-4 text-[var(--color-text-secondary)] opacity-60">
              Atendimento livre não precisa de template: responda dentro da janela
              de 24h direto pelo Inbox.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl_lang">Idioma</Label>
            <Input
              id="tpl_lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={saving}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
          <div className="space-y-2">
            <Label htmlFor="tpl_header">Header</Label>
            <select
              id="tpl_header"
              value={headerType}
              onChange={(e) => setHeaderType(e.target.value as HeaderType)}
              disabled={saving}
              className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
            >
              {HEADER_TYPES.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
          {headerType === 'text' && (
            <div className="space-y-2">
              <Label htmlFor="tpl_header_text">Texto do header</Label>
              <Input
                id="tpl_header_text"
                value={headerContent}
                onChange={(e) => setHeaderContent(e.target.value)}
                disabled={saving}
              />
            </div>
          )}
          {headerType !== 'text' && headerType !== 'none' && (
            <div className="space-y-2">
              <Label htmlFor="tpl_header_media">URL da mídia (exemplo)</Label>
              <Input
                id="tpl_header_media"
                value={headerContent}
                onChange={(e) => setHeaderContent(e.target.value)}
                placeholder="https://.../exemplo.jpg"
                disabled={saving}
              />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="tpl_body">Body</Label>
          <textarea
            id="tpl_body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Olá! Seu pedido foi confirmado e já está em separação."
            rows={5}
            disabled={saving}
            className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-3 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              Use {'{{1}}'}, {'{{2}}'}… para variáveis. Máximo ~1024 caracteres (limite Meta).
            </p>
            <button
              type="button"
              onClick={() => setBody((cur) => `${cur}{{${extractVariables(cur).length + 1}}}`)}
              disabled={saving}
              className="shrink-0 rounded-md border border-[rgba(59,130,246,0.25)] px-2 py-1 text-[11px] text-[var(--accent-secondary)] transition hover:border-[var(--accent-primary)]"
            >
              + Variável
            </button>
          </div>
        </div>

        {detectedVars.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.02] p-3">
            <div className="text-xs font-semibold text-[var(--color-text-primary)]">
              Exemplos das variáveis (exigidos pela Meta para aprovação)
            </div>
            {detectedVars.map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-12 shrink-0 font-mono text-xs text-[var(--accent-secondary)]">{`{{${i}}}`}</span>
                <Input
                  value={varExamples[String(i)] ?? ''}
                  onChange={(e) => setVarExamples((cur) => ({ ...cur, [String(i)]: e.target.value }))}
                  placeholder={`Exemplo p/ variável ${i} (ex.: João)`}
                  disabled={saving}
                />
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)] opacity-80">
              Em campanhas, cada variável pode ser o nome do contato (personalizado por
              destinatário) ou um valor fixo igual para todos — você escolhe ao criar a
              campanha. Em envios 1:1 (inbox e automações) você preenche os valores na hora.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="tpl_footer">Footer (opcional)</Label>
          <Input
            id="tpl_footer"
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            placeholder="Mensagem curta no rodapé"
            disabled={saving}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Botões</Label>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => addButton('quick_reply')}>
                <Plus className="h-3.5 w-3.5" />
                Quick reply
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => addButton('url')}>
                <Plus className="h-3.5 w-3.5" />
                URL
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => addButton('phone')}>
                <Plus className="h-3.5 w-3.5" />
                Telefone
              </Button>
            </div>
          </div>
          {buttons.length === 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)] opacity-60">
              Sem botões. Máx 3 quick_reply OU 2 CTA (URL/telefone).
            </p>
          ) : (
            <div className="space-y-2">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] w-20">
                    {b.type}
                  </span>
                  <Input
                    value={b.text}
                    onChange={(e) =>
                      setButtons((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], text: e.target.value };
                        return next;
                      })
                    }
                    placeholder="Texto do botão"
                    disabled={saving}
                  />
                  {b.type === 'url' && (
                    <Input
                      value={b.url}
                      onChange={(e) =>
                        setButtons((prev) => {
                          const next = [...prev];
                          const prevBtn = next[i];
                          if (prevBtn.type === 'url') {
                            next[i] = { ...prevBtn, url: e.target.value };
                          }
                          return next;
                        })
                      }
                      placeholder="https://..."
                      disabled={saving}
                    />
                  )}
                  {b.type === 'phone' && (
                    <Input
                      value={b.phone}
                      onChange={(e) =>
                        setButtons((prev) => {
                          const next = [...prev];
                          const prevBtn = next[i];
                          if (prevBtn.type === 'phone') {
                            next[i] = { ...prevBtn, phone: e.target.value };
                          }
                          return next;
                        })
                      }
                      placeholder="+55..."
                      disabled={saving}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setButtons((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label="Remover botão"
                  >
                    <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Salvando...
              </>
            ) : isEdit ? (
              <>Salvar alterações</>
            ) : (
              <>Salvar como draft</>
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
