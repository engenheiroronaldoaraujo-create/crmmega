import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Link2, Loader2, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUtmLinks, type UtmLink } from '@/hooks/useUtmLinks';
import { buildUtmUrl, UTM_PRESETS } from '@/lib/utm';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function UtmBuilder() {
  const { links, loading, error, reload, create, remove } = useUtmLinks();
  const [baseUrl, setBaseUrl] = useState('');
  const [source, setSource] = useState('');
  const [medium, setMedium] = useState('');
  const [campaign, setCampaign] = useState('');
  const [content, setContent] = useState('');
  const [term, setTerm] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const finalUrl = useMemo(
    () =>
      buildUtmUrl(baseUrl, {
        utm_source: source,
        utm_medium: medium,
        utm_campaign: campaign,
        utm_content: content,
        utm_term: term,
      }),
    [baseUrl, source, medium, campaign, content, term],
  );

  const canGenerate = baseUrl.trim() !== '' && source.trim() !== '' && medium.trim() !== '';

  const applyPreset = (p: (typeof UTM_PRESETS)[number]) => {
    setSource(p.source);
    setMedium(p.medium);
  };

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) toast.success('URL copiada.');
    else toast.error('Não foi possível copiar — copie manualmente.');
  };

  const handleSave = async () => {
    if (!canGenerate) return;
    setSaving(true);
    try {
      await create({
        base_url: baseUrl.trim(),
        utm_source: source.trim() || null,
        utm_medium: medium.trim() || null,
        utm_campaign: campaign.trim() || null,
        utm_content: content.trim() || null,
        utm_term: term.trim() || null,
        final_url: finalUrl,
        label: label.trim() || null,
      });
      toast.success('URL salva no histórico.');
      setLabel('');
    } catch (err) {
      toast.error('Falha ao salvar', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (l: UtmLink) => {
    if (!confirm('Remover esta URL do histórico?')) return;
    try {
      await remove(l.id);
    } catch (err) {
      toast.error('Falha ao remover', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-[var(--accent-primary)]" />
        <p className="text-sm text-[var(--color-text-secondary)]">
          Gere URLs rastreáveis com UTMs. A origem dos leads (orgânico/pago, canal, campanha)
          é derivada automaticamente desses parâmetros.
        </p>
      </div>

      {/* Presets */}
      <div className="space-y-2">
        <div className="text-label">Presets por canal</div>
        <div className="flex flex-wrap gap-1.5">
          {UTM_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              className={
                'rounded-full px-3 py-1 text-xs font-semibold border transition-colors ' +
                (source === p.source && medium === p.medium
                  ? 'border-[var(--accent-primary)] bg-[rgba(59,130,246,0.15)] text-[var(--color-text-primary)]'
                  : 'border-[rgba(59,130,246,0.15)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[rgba(59,130,246,0.35)]')
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Form */}
      <div className="glass-card p-5 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="utm_base">URL base *</Label>
          <Input
            id="utm_base"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://seusite.com/landing"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="utm_source">utm_source *</Label>
            <Input id="utm_source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="instagram" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="utm_medium">utm_medium *</Label>
            <Input id="utm_medium" value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="paid_social" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="utm_campaign">utm_campaign</Label>
            <Input id="utm_campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="lancamento_julho" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="utm_content">utm_content (anúncio/criativo)</Label>
            <Input id="utm_content" value={content} onChange={(e) => setContent(e.target.value)} placeholder="video_a" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="utm_term">utm_term</Label>
            <Input id="utm_term" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="palavra-chave" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="utm_label">Rótulo (opcional)</Label>
            <Input id="utm_label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Story CTA julho" />
          </div>
        </div>

        {/* Resultado */}
        <div className="space-y-2">
          <Label>URL final</Label>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-xs font-mono text-[var(--color-text-primary)] break-all min-h-[40px]">
              {finalUrl || <span className="opacity-40">Preencha a URL base e os parâmetros obrigatórios…</span>}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => finalUrl && handleCopy(finalUrl)}
              disabled={!finalUrl}
              aria-label="Copiar URL"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={handleSave} disabled={!canGenerate || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar no histórico
          </Button>
        </div>
      </div>

      {/* Histórico */}
      <div className="space-y-2">
        <div className="text-label">Histórico de URLs</div>
        {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}
        <div className="glass-card p-4">
          {loading ? (
            <div className="py-8 text-center text-label opacity-60">Carregando...</div>
          ) : links.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--color-text-secondary)] opacity-60">
              Nenhuma URL gerada ainda.
            </div>
          ) : (
            <div className="space-y-2">
              {links.map((l) => (
                <div
                  key={l.id}
                  className="flex items-start gap-3 rounded-lg border border-[rgba(59,130,246,0.08)] bg-white/[0.02] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {l.label && (
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">{l.label}</span>
                      )}
                      {l.utm_campaign && (
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {l.utm_campaign}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs font-mono text-[var(--color-text-secondary)] break-all">
                      {l.final_url}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="icon" variant="ghost" onClick={() => handleCopy(l.final_url)} aria-label="Copiar">
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(l)} aria-label="Remover">
                      <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
