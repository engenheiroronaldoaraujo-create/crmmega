import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

type Row = { alias: string; canonical: string };

// Canônicos aceitos pela derivação (tokens de source). O canal final (orgânico
// vs pago) é decidido pelo utm_medium no servidor.
const CANONICAL_HINTS = ['instagram', 'facebook', 'google', 'tiktok', 'linkedin', 'youtube'];

function toRows(map: unknown): Row[] {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map as Record<string, unknown>).map(([alias, canonical]) => ({
    alias,
    canonical: String(canonical ?? ''),
  }));
}

// Mapa de canal (utm_source → canônico). Vivia em Configurações → UTMs;
// agora acompanha o gerador de UTMs na aba Campanhas → UTMs. Escrita em
// app_settings é admin-only (RLS), então o card só aparece para admin.
export function UtmChannelMap() {
  const { userId, role } = useAppUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const isAdmin = role === 'admin';

  useEffect(() => {
    if (!userId || !isAdmin) return;
    const supabase = getSupabase();
    supabase
      .from('app_settings')
      .select('utm_channel_map')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => {
        setRows(toRows(data?.utm_channel_map));
        setLoading(false);
      });
  }, [userId, isAdmin]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { alias: '', canonical: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    // Normaliza: alias e canonical em minúsculas; descarta linhas incompletas.
    const map: Record<string, string> = {};
    for (const { alias, canonical } of rows) {
      const a = alias.trim().toLowerCase();
      const c = canonical.trim().toLowerCase();
      if (a && c) map[a] = c;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase
      .from('app_settings')
      .update({ utm_channel_map: map })
      .eq('id', 1);
    setSaving(false);
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
      return;
    }
    toast.success('Mapeamento de canal salvo.');
  };

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div className="glass-card p-5">
        <div className="text-label opacity-60 py-8 text-center">Carregando...</div>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <form onSubmit={handleSubmit} className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Mapeamento de canal (UTM)</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Normaliza variações de nomenclatura do <code>utm_source</code> para um token
            canônico antes de derivar o canal de origem. Ex.: <code>ig → instagram</code>,{' '}
            <code>fb → facebook</code>. Vale para leads criados/atualizados após salvar.
          </p>
        </header>

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
              Nenhum alias configurado — a derivação usa o <code>utm_source</code> como está.
            </p>
          )}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r.alias}
                onChange={(e) => setRow(i, { alias: e.target.value })}
                placeholder="alias (ex.: ig)"
                disabled={saving}
                className="font-mono max-w-[220px]"
              />
              <span className="text-[var(--color-text-secondary)]">→</span>
              <Input
                value={r.canonical}
                onChange={(e) => setRow(i, { canonical: e.target.value })}
                placeholder="canônico (ex.: instagram)"
                disabled={saving}
                className="font-mono"
                list="utm-canonical-hints"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeRow(i)}
                disabled={saving}
                aria-label="Remover linha"
              >
                <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
              </Button>
            </div>
          ))}
          <datalist id="utm-canonical-hints">
            {CANONICAL_HINTS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Button type="button" variant="ghost" size="sm" onClick={addRow} disabled={saving}>
            <Plus className="h-3.5 w-3.5" />
            Adicionar alias
          </Button>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Salvando...
              </>
            ) : (
              <>Salvar alterações</>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
