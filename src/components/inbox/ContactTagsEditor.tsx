import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useTags } from '@/hooks/useTags';

// Tags rápidas do contato no inbox: chips com remover + dropdown para adicionar
// uma tag existente. Lê/escreve whatsapp_hub.contact_tags.
export function ContactTagsEditor({ contactId }: { contactId: string }) {
  const { tags: allTags } = useTags();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const supabase = getSupabase();
    const { data } = await supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId);
    setTagIds(((data ?? []) as Array<{ tag_id: string }>).map((r) => r.tag_id));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const attach = async (tagId: string) => {
    setAdding(false);
    if (tagIds.includes(tagId)) return;
    const supabase = getSupabase();
    const { error } = await supabase.schema('whatsapp_hub').from('contact_tags').insert({ contact_id: contactId, tag_id: tagId });
    if (error) {
      toast.error('Falha ao adicionar tag', { description: error.message });
      return;
    }
    setTagIds((prev) => [...prev, tagId]);
  };

  const detach = async (tagId: string) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', tagId);
    if (error) {
      toast.error('Falha ao remover tag', { description: error.message });
      return;
    }
    setTagIds((prev) => prev.filter((id) => id !== tagId));
  };

  const byId = new Map(allTags.map((t) => [t.id, t]));
  const available = allTags.filter((t) => !tagIds.includes(t.id));

  return (
    <div className="space-y-2">
      <div className="text-label">Tags</div>
      <div className="flex flex-wrap gap-1.5">
        {tagIds.map((id) => {
          const t = byId.get(id);
          if (!t) return null;
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{ backgroundColor: `${t.color}22`, color: t.color }}
            >
              {t.name}
              <button type="button" onClick={() => detach(id)} aria-label={`Remover ${t.name}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <div className="relative">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-[rgba(59,130,246,0.25)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <Plus className="h-3 w-3" />
            Tag
          </button>
          {adding && (
            <div className="absolute z-20 mt-1 w-48 rounded-lg border border-[rgba(59,130,246,0.25)] bg-[#0F1223] shadow-2xl overflow-hidden max-h-56 overflow-y-auto">
              {available.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] opacity-70">
                  Sem tags disponíveis. Crie em Contatos.
                </div>
              ) : (
                available.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => attach(t.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[rgba(59,130,246,0.12)]"
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="text-[var(--color-text-primary)]">{t.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
