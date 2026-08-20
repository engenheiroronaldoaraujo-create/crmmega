import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

const BUCKET = 'whatsapp-hub-agent-media';
const MAX_BYTES = 25 * 1024 * 1024;

type MediaRow = {
  id: string;
  label: string;
  media_url: string;
  content_type: string;
  usage_note: string | null;
  storage_path: string | null;
};

function classify(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export function AgentMediaSettings() {
  const { orgId } = useAppUser();
  const [items, setItems] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('ai_agent_media')
      .select('id, label, media_url, content_type, usage_note, storage_path')
      .order('created_at', { ascending: false });
    if (error) toast.error('Falha ao carregar mídias', { description: error.message });
    else setItems((data ?? []) as MediaRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > MAX_BYTES) {
      toast.error('Arquivo excede 25MB.');
      e.target.value = '';
      return;
    }
    setFile(f);
    if (f && !label.trim()) {
      // Sugere um rótulo a partir do nome do arquivo (slug).
      setLabel(f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      toast.error('Informe um rótulo.');
      return;
    }
    if (!file) {
      toast.error('Selecione um arquivo.');
      return;
    }
    if (!orgId) {
      toast.error('Sessão sem organização. Recarregue a página.');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    // O path DEVE começar com `<org_id>/` — a policy RLS de INSERT do bucket
    // whatsapp-hub-agent-media exige (storage.foldername(name))[1] = current_org_id().
    const path = `${orgId}/${crypto.randomUUID()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upErr) {
      setSaving(false);
      toast.error('Falha no upload', { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

    const { error: insErr } = await supabase.from('ai_agent_media').insert({
      label: label.trim(),
      media_url: pub.publicUrl,
      content_type: classify(file.type || ''),
      usage_note: note.trim() || null,
      storage_path: path,
    });
    setSaving(false);
    if (insErr) {
      // Limpa o objeto órfão se o insert falhar.
      await supabase.storage.from(BUCKET).remove([path]);
      toast.error('Falha ao salvar', { description: insErr.message });
      return;
    }
    setLabel('');
    setNote('');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    toast.success('Mídia enviada.');
    void load();
  };

  const remove = async (m: MediaRow) => {
    const supabase = getSupabase();
    if (m.storage_path) {
      await supabase.storage.from(BUCKET).remove([m.storage_path]);
    }
    const { error } = await supabase.from('ai_agent_media').delete().eq('id', m.id);
    if (error) {
      toast.error('Falha ao remover', { description: error.message });
      return;
    }
    void load();
  };

  return (
    <Card>
      <div className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Mídias do agente</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Suba as mídias que o agente pode enviar. O arquivo fica no Storage e a
            URL pública é usada no envio. Referencie o rótulo no prompt para
            instruir em que momento da conversa enviá-las.
          </p>
        </header>

        <form onSubmit={add} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="m_label">Rótulo</Label>
            <Input id="m_label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="catalogo_pdf" disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label>Arquivo (máx 25MB)</Label>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*,application/pdf"
              onChange={onPickFile}
              disabled={saving}
            />
            {file ? (
              <div className="flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 h-11 text-sm">
                <Paperclip className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                <span className="truncate text-[var(--color-text-primary)]">{file.name}</span>
                <span className="text-[var(--color-text-secondary)] text-xs">{(file.size / 1024 / 1024).toFixed(1)}MB</span>
                <button type="button" onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="ml-auto text-[var(--color-text-secondary)] hover:text-[var(--color-error)]" aria-label="Remover arquivo">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={saving} className="w-full justify-start">
                <Paperclip className="h-4 w-4" />
                Selecionar arquivo
              </Button>
            )}
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="m_note">Quando enviar (instrução)</Label>
            <Input id="m_note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex: enviar quando o lead pedir o catálogo" disabled={saving} />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={saving || !file}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Enviar mídia
            </Button>
          </div>
        </form>

        <div className="space-y-2">
          <div className="text-label">Mídias cadastradas</div>
          {loading ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-60">Carregando...</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-60">Nenhuma mídia ainda.</div>
          ) : (
            <ul className="divide-y divide-[rgba(59,130,246,0.08)] rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02]">
              {items.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-mono text-[var(--color-text-primary)] truncate">{m.label}</div>
                    <div className="text-xs text-[var(--color-text-secondary)] truncate">
                      {m.content_type} · <a href={m.media_url} target="_blank" rel="noreferrer" className="text-[var(--accent-primary)] hover:underline">abrir</a>
                    </div>
                    {m.usage_note && (
                      <div className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">{m.usage_note}</div>
                    )}
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => remove(m)} aria-label={`Remover ${m.label}`}>
                    <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
