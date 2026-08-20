import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase';

type Row = { key: string; value: string };

// Editor de campos personalizados do contato (contacts.custom_fields jsonb).
// Modo leitura por padrão; "Editar" abre os inputs de chave/valor.
export function CustomFieldsEditor({
  contactId,
  customFields,
  onSaved,
}: {
  contactId: string;
  customFields: Record<string, unknown>;
  onSaved?: () => void;
}) {
  const initial = (): Row[] =>
    Object.entries(customFields ?? {})
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([key, value]) => ({ key, value: String(value) }));

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setRows(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, customFields]);

  const save = async () => {
    const obj: Record<string, string> = {};
    for (const { key, value } of rows) {
      const k = key.trim();
      if (k) obj[k] = value;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('contacts')
      .update({ custom_fields: obj })
      .eq('id', contactId);
    setSaving(false);
    if (error) {
      toast.error('Falha ao salvar campos', { description: error.message });
      return;
    }
    toast.success('Campos personalizados salvos.');
    setEditing(false);
    onSaved?.();
  };

  const entries = initial();

  if (!editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-label">Campos personalizados</div>
          <button
            type="button"
            onClick={() => { setRows(initial()); setEditing(true); }}
            className="inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <Pencil className="h-3 w-3" />
            Editar
          </button>
        </div>
        {entries.length === 0 ? (
          <div className="text-xs text-[var(--color-text-secondary)] opacity-60">Nenhum campo.</div>
        ) : (
          <dl className="text-sm space-y-1.5">
            {entries.map(({ key, value }) => (
              <div key={key} className="flex items-start justify-between gap-3">
                <dt className="text-[var(--color-text-secondary)] text-xs uppercase tracking-wide shrink-0">{key}</dt>
                <dd className="text-[var(--color-text-primary)] text-right break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-label">Campos personalizados</div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={r.key}
              onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))}
              placeholder="campo"
              className="h-9 text-xs max-w-[120px]"
            />
            <Input
              value={r.value}
              onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))}
              placeholder="valor"
              className="h-9 text-xs"
            />
            <button type="button" onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))} aria-label="Remover campo" className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setRows((p) => [...p, { key: '', value: '' }])}>
          <Plus className="h-3.5 w-3.5" />
          Campo
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          <Check className="h-3.5 w-3.5" />
          Salvar
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
