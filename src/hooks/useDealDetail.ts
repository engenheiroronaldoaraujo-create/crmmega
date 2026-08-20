import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import type {
  ContactFull,
  CustomField,
  CustomFieldType,
  Deal,
  DealProduct,
  Product,
  Tag,
} from '@/types/crm';

export interface DealNote {
  id: string;
  body: string | null;
  title: string | null;
  created_at: string;
}

interface CreateFieldInput {
  label: string;
  field_type: CustomFieldType;
  options: string[] | null;
  required: boolean;
}

const TAG_DEFAULT_COLOR = '#60A5FA';

interface UseDealDetailResult {
  contact: ContactFull | null;
  fields: CustomField[];
  values: Record<string, string>;
  notes: DealNote[];
  products: DealProduct[];      // produtos associados a este deal (com valor da compra)
  tags: Tag[];                  // tags associadas a este deal
  productCatalog: Product[];    // catálogo da org (autocomplete)
  tagCatalog: Tag[];            // catálogo de tags da org
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  saveValue: (fieldId: string, value: string) => Promise<void>;
  addNote: (body: string) => Promise<void>;
  createField: (input: CreateFieldInput) => Promise<CustomField | null>;
  saveContact: (patch: Partial<Pick<ContactFull, 'name' | 'phone' | 'email' | 'source'>>) => Promise<string | null>;
  saveDeal: (patch: Partial<Deal>) => Promise<string | null>;
  addProduct: (name: string) => Promise<void>;
  removeProduct: (productId: string) => Promise<void>;
  addTag: (name: string) => Promise<void>;
  removeTag: (tagId: string) => Promise<void>;
}

export function useDealDetail(deal: Deal | null): UseDealDetailResult {
  const [contact, setContact] = useState<ContactFull | null>(null);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<DealNote[]>([]);
  const [products, setProducts] = useState<DealProduct[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [productCatalog, setProductCatalog] = useState<Product[]>([]);
  const [tagCatalog, setTagCatalog] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!deal) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    const [contactRes, fieldsRes, valuesRes, notesRes, dpRes, dtRes, prodRes, tagRes] = await Promise.all([
      supabase.from('contacts').select('id, name, phone, email, source, custom_fields, created_at, updated_at').eq('id', deal.contact_id).single(),
      supabase.from('custom_fields').select('*').order('position'),
      supabase.from('custom_field_values').select('*').eq('deal_id', deal.id),
      supabase.from('crm_activities').select('id, body, title, created_at').eq('deal_id', deal.id).eq('type', 'note').order('created_at', { ascending: false }).limit(100),
      supabase.from('deal_products').select('value, quantity, product:product_id(id, name)').eq('deal_id', deal.id),
      supabase.from('deal_tags').select('tag:tag_id(id, name, color)').eq('deal_id', deal.id),
      supabase.from('products').select('id, name, product_type, quantity').order('name'),
      supabase.from('tags').select('id, name, color').order('name'),
    ]);

    if (contactRes.error) {
      setError(contactRes.error.message);
      setLoading(false);
      return;
    }
    setContact(contactRes.data as ContactFull);
    setFields((fieldsRes.data ?? []) as CustomField[]);
    const valueMap: Record<string, string> = {};
    for (const v of (valuesRes.data ?? []) as Array<{ custom_field_id: string; value: string | null }>) {
      valueMap[v.custom_field_id] = v.value ?? '';
    }
    setValues(valueMap);
    setNotes((notesRes.data ?? []) as DealNote[]);
    setProducts(
      ((dpRes.data ?? []) as unknown as Array<{ value: number | null; quantity: number | null; product: Product | null }>)
        .filter((x) => Boolean(x.product))
        .map((x) => ({ id: x.product!.id, name: x.product!.name, value: x.value, quantity: x.quantity ?? 1 })),
    );
    setTags(((dtRes.data ?? []) as unknown as Array<{ tag: Tag | null }>).map((x) => x.tag).filter((t): t is Tag => Boolean(t)));
    setProductCatalog((prodRes.data ?? []) as Product[]);
    setTagCatalog((tagRes.data ?? []) as Tag[]);
    setLoading(false);
  }, [deal]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveValue = useCallback(async (fieldId: string, value: string) => {
    if (!deal) return;
    setValues((cur) => ({ ...cur, [fieldId]: value }));
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('custom_field_values')
      .upsert({ custom_field_id: fieldId, deal_id: deal.id, value, updated_at: new Date().toISOString() }, { onConflict: 'custom_field_id,deal_id' });
    if (err) setError(err.message);
  }, [deal]);

  const addNote = useCallback(async (body: string) => {
    if (!deal) return;
    const text = body.trim();
    if (!text) return;
    const supabase = getSupabase();
    const { error: err } = await supabase.from('crm_activities').insert({ deal_id: deal.id, contact_id: deal.contact_id, type: 'note', body: text });
    if (err) { setError(err.message); return; }
    await reload();
  }, [deal, reload]);

  const createField = useCallback<UseDealDetailResult['createField']>(async (input) => {
    const supabase = getSupabase();
    const nextPos = fields.reduce((m, f) => Math.max(m, f.position), -1) + 1;
    const { data, error: err } = await supabase
      .from('custom_fields')
      .insert({ label: input.label, field_type: input.field_type, options: input.options, required: input.required, position: nextPos })
      .select('*')
      .single();
    if (err) { setError(err.message); return null; }
    const field = data as CustomField;
    setFields((cur) => [...cur, field].sort((a, b) => a.position - b.position));
    return field;
  }, [fields]);

  const saveContact = useCallback<UseDealDetailResult['saveContact']>(async (patch) => {
    if (!deal) return 'Sem contato.';
    const supabase = getSupabase();
    setContact((cur) => (cur ? { ...cur, ...patch } : cur));
    const { error: err } = await supabase.from('contacts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', deal.contact_id);
    if (err) { setError(err.message); return err.message; }
    return null;
  }, [deal]);

  const saveDeal = useCallback<UseDealDetailResult['saveDeal']>(async (patch) => {
    if (!deal) return 'Sem negócio.';
    const supabase = getSupabase();
    const { error: err } = await supabase.from('deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', deal.id);
    if (err) { setError(err.message); return err.message; }
    return null;
  }, [deal]);

  const addProduct = useCallback(async (name: string) => {
    if (!deal) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const supabase = getSupabase();
    // upsert no catálogo (unique name) e recupera o id
    const { data: up, error: upErr } = await supabase.from('products').upsert({ name: trimmed }, { onConflict: 'name' }).select('id, name, product_type, quantity').single();
    if (upErr) { setError(upErr.message); return; }
    const product = up as Product;
    const { error: linkErr } = await supabase.from('deal_products').upsert({ deal_id: deal.id, product_id: product.id });
    if (linkErr) { setError(linkErr.message); return; }
    setProducts((cur) => (cur.some((p) => p.id === product.id) ? cur : [...cur, { id: product.id, name: product.name, value: null, quantity: 1 }]));
    setProductCatalog((cur) => (cur.some((p) => p.id === product.id) ? cur : [...cur, product].sort((a, b) => a.name.localeCompare(b.name))));
  }, [deal]);

  const removeProduct = useCallback(async (productId: string) => {
    if (!deal) return;
    const supabase = getSupabase();
    setProducts((cur) => cur.filter((p) => p.id !== productId));
    await supabase.from('deal_products').delete().eq('deal_id', deal.id).eq('product_id', productId);
  }, [deal]);

  const addTag = useCallback(async (name: string) => {
    if (!deal) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const supabase = getSupabase();
    const { data: up, error: upErr } = await supabase.from('tags').upsert({ name: trimmed, color: TAG_DEFAULT_COLOR }, { onConflict: 'name' }).select('id, name, color').single();
    if (upErr) { setError(upErr.message); return; }
    const tag = up as Tag;
    const { error: linkErr } = await supabase.from('deal_tags').upsert({ deal_id: deal.id, tag_id: tag.id });
    if (linkErr) { setError(linkErr.message); return; }
    setTags((cur) => (cur.some((t) => t.id === tag.id) ? cur : [...cur, tag]));
    setTagCatalog((cur) => (cur.some((t) => t.id === tag.id) ? cur : [...cur, tag].sort((a, b) => a.name.localeCompare(b.name))));
  }, [deal]);

  const removeTag = useCallback(async (tagId: string) => {
    if (!deal) return;
    const supabase = getSupabase();
    setTags((cur) => cur.filter((t) => t.id !== tagId));
    await supabase.from('deal_tags').delete().eq('deal_id', deal.id).eq('tag_id', tagId);
  }, [deal]);

  return {
    contact, fields, values, notes, products, tags, productCatalog, tagCatalog,
    loading, error, reload,
    saveValue, addNote, createField, saveContact, saveDeal,
    addProduct, removeProduct, addTag, removeTag,
  };
}
