import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { useProducts } from '@/hooks/useProducts';
import { PRODUCT_TYPE_LABELS, productTypeLabel, type Product } from '@/types/crm';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';

const TYPE_OPTIONS = Object.entries(PRODUCT_TYPE_LABELS);
const CUSTOM = '__custom__';

const selectCls =
  'h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]';

// Normaliza o tipo personalizado: minúsculo, sem acento, espaços → underscore.
function slugifyType(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Seletor de tipo com opção "Personalizado…" (classes livres, ex.: imóveis).
function TypePicker({
  value, custom, onValue, onCustom, disabled, idPrefix,
}: {
  value: string;
  custom: string;
  onValue: (v: string) => void;
  onCustom: (v: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const isKnown = value !== CUSTOM && Boolean(PRODUCT_TYPE_LABELS[value]);
  return (
    <div className="space-y-2">
      <select
        id={`${idPrefix}_type`}
        value={isKnown ? value : CUSTOM}
        onChange={(e) => onValue(e.target.value)}
        disabled={disabled}
        className={selectCls}
      >
        {TYPE_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
        <option value={CUSTOM}>Personalizado…</option>
      </select>
      {!isKnown && (
        <Input
          value={custom}
          onChange={(e) => onCustom(e.target.value)}
          placeholder="Nome da classe (ex.: Imóvel)"
          disabled={disabled}
        />
      )}
    </div>
  );
}

// Configurações → Produtos. Catálogo da organização; produtos podem ser
// atribuídos a leads/negócios pelo funil. Tipos personalizáveis (ex.: imóveis)
// e descrição opcional por produto.
export function ProductsSettings() {
  const { products, loading, error, reload, create, update, remove } = useProducts();

  const [name, setName] = useState('');
  const [type, setType] = useState('curso');
  const [customType, setCustomType] = useState('');
  const [quantity, setQuantity] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('curso');
  const [editCustomType, setEditCustomType] = useState('');
  const [editQuantity, setEditQuantity] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const parseQty = (raw: string): number | null => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const resolveType = (selected: string, custom: string): string | null => {
    if (selected !== CUSTOM && PRODUCT_TYPE_LABELS[selected]) return selected;
    const slug = slugifyType(custom);
    return slug || null;
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const finalType = resolveType(type, customType);
    if (!finalType) {
      toast.error('Informe o nome da classe personalizada.');
      return;
    }
    setSaving(true);
    try {
      await create({
        name,
        product_type: finalType,
        quantity: parseQty(quantity),
        description: description.trim() || null,
      });
      toast.success('Produto cadastrado.');
      setName('');
      setType('curso');
      setCustomType('');
      setQuantity('');
      setDescription('');
    } catch (err) {
      toast.error('Falha ao cadastrar', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (p: Product) => {
    setEditingId(p.id);
    setEditName(p.name);
    if (PRODUCT_TYPE_LABELS[p.product_type]) {
      setEditType(p.product_type);
      setEditCustomType('');
    } else {
      setEditType(CUSTOM);
      setEditCustomType(p.product_type);
    }
    setEditQuantity(p.quantity != null ? String(p.quantity) : '');
    setEditDescription(p.description ?? '');
  };

  const handleUpdate = async () => {
    if (!editingId || !editName.trim()) return;
    const finalType = resolveType(editType, editCustomType);
    if (!finalType) {
      toast.error('Informe o nome da classe personalizada.');
      return;
    }
    setEditSaving(true);
    try {
      await update(editingId, {
        name: editName.trim(),
        product_type: finalType,
        quantity: parseQty(editQuantity),
        description: editDescription.trim() || null,
      });
      toast.success('Produto atualizado.');
      setEditingId(null);
    } catch (err) {
      toast.error('Falha ao atualizar', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemove = async (p: Product) => {
    if (!confirm(`Excluir o produto "${p.name}"? Ele será desvinculado dos negócios.`)) return;
    try {
      await remove(p.id);
      toast.success('Produto excluído.');
    } catch (err) {
      toast.error('Falha ao excluir', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <form onSubmit={handleCreate} className="space-y-5">
          <header className="space-y-1">
            <h2 className="text-xl font-bold text-display">Produtos</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Cadastre o catálogo da sua operação — incluindo classes personalizadas
              (ex.: imóveis). Os produtos podem ser atribuídos a leads/negócios no funil.
            </p>
          </header>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px_140px_auto] gap-3 items-start">
            <div className="space-y-2">
              <Label htmlFor="product_name">Nome *</Label>
              <Input
                id="product_name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex.: Mentoria Black"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product_type">Tipo *</Label>
              <TypePicker
                value={type}
                custom={customType}
                onValue={setType}
                onCustom={setCustomType}
                disabled={saving}
                idPrefix="product"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product_qty">Quantidade</Label>
              <Input
                id="product_qty"
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Opcional"
                disabled={saving}
              />
            </div>
            <div className="pt-7">
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Cadastrar
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="product_desc">Descrição</Label>
            <textarea
              id="product_desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Opcional — descrição do produto (aparece no catálogo)"
              disabled={saving}
              className="w-full resize-none rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
        </form>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="text-label">Catálogo</div>
          {error && <LoadErrorBanner message={error} onRetry={() => void reload()} />}
          {loading ? (
            <div className="py-8 text-center text-label opacity-60">Carregando...</div>
          ) : products.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--color-text-secondary)] opacity-60">
              <Package className="mx-auto mb-2 h-6 w-6 opacity-50" />
              Nenhum produto cadastrado ainda.
            </div>
          ) : (
            <div className="space-y-2">
              {products.map((p) =>
                editingId === p.id ? (
                  <div
                    key={p.id}
                    className="space-y-2 rounded-lg border border-[rgba(59,130,246,0.25)] bg-white/[0.03] p-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px_120px] gap-2 items-start">
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={editSaving} />
                      <TypePicker
                        value={editType}
                        custom={editCustomType}
                        onValue={setEditType}
                        onCustom={setEditCustomType}
                        disabled={editSaving}
                        idPrefix="edit"
                      />
                      <Input
                        type="number"
                        min={0}
                        value={editQuantity}
                        onChange={(e) => setEditQuantity(e.target.value)}
                        placeholder="Qtd."
                        disabled={editSaving}
                      />
                    </div>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      rows={2}
                      placeholder="Descrição (opcional)"
                      disabled={editSaving}
                      className="w-full resize-none rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
                    />
                    <div className="flex items-center gap-1 justify-end">
                      <Button size="sm" onClick={handleUpdate} disabled={editSaving || !editName.trim()}>
                        {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setEditingId(null)} disabled={editSaving} aria-label="Cancelar edição">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 rounded-lg border border-[rgba(59,130,246,0.08)] bg-white/[0.02] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">{p.name}</span>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {productTypeLabel(p.product_type)}
                        </span>
                        {p.quantity != null && (
                          <span className="text-[10px] text-[var(--color-text-secondary)]">
                            Qtd.: {p.quantity}
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]">{p.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="icon" variant="ghost" onClick={() => startEdit(p)} aria-label="Editar">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => void handleRemove(p)} aria-label="Excluir">
                        <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                      </Button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
