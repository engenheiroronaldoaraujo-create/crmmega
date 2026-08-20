import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupabase } from '@/lib/supabase';
import { useTemplates } from '@/hooks/useTemplates';
import { extractVariables } from '@/types/templates';

interface Props {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent?: () => void;
}

export function TemplateRestartDialog({ open, onClose, conversationId, onSent }: Props) {
  const { templates } = useTemplates();
  const approved = useMemo(() => templates.filter((t) => t.status === 'approved'), [templates]);
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const selected = approved.find((t) => t.id === templateId) ?? null;
  const vars = useMemo(() => (selected ? extractVariables(selected.body) : []), [selected]);

  const send = async () => {
    if (!selected) {
      toast.error('Selecione um template.');
      return;
    }
    const params = vars.map((idx) => values[idx] ?? '');
    setSending(true);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('send-operator-template', {
      body: { conversation_id: conversationId, template_id: selected.id, params },
    });
    setSending(false);
    if (error || !data?.ok) {
      toast.error('Falha ao enviar template', { description: data?.error ?? error?.message ?? 'Erro' });
      return;
    }
    toast.success('Template enviado — conversa reiniciada.');
    setTemplateId('');
    setValues({});
    onSent?.();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Reiniciar com template" widthClass="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          O contato está fora da janela de 24h. A Meta só permite reabrir a conversa
          com um template aprovado.
        </p>
        <div className="space-y-2">
          <Label htmlFor="restart_tpl">Template aprovado</Label>
          <select
            id="restart_tpl"
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setValues({});
            }}
            className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Selecione…</option>
            {approved.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {approved.length === 0 && (
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              Nenhum template aprovado. Crie e aprove um em Templates.
            </p>
          )}
        </div>

        {selected && (
          <div className="rounded-lg border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-3 text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap">
            {selected.body}
          </div>
        )}

        {vars.length > 0 && (
          <div className="space-y-2">
            <Label>Variáveis</Label>
            {vars.map((idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="font-mono text-xs bg-white/5 rounded px-2 py-1 text-[var(--accent-primary)]">
                  {`{{${idx}}}`}
                </span>
                <Input
                  value={values[idx] ?? ''}
                  onChange={(e) => setValues((p) => ({ ...p, [idx]: e.target.value }))}
                  placeholder={selected?.variables?.[idx] ?? `Valor de {{${idx}}}`}
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancelar</Button>
          <Button onClick={send} disabled={sending || !selected}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Enviar template
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
