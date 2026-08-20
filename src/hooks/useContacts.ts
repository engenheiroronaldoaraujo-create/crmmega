import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { Contact, ContactWithTags, Tag } from '@/types/db';

export type ContactSort = 'recent' | 'oldest' | 'name' | 'first_seen';
export type LeadTypeFilter = 'Lead' | 'Cliente';

// Linha do export CSV (nome, telefone, e-mail, canal, origem, tags, primeiro
// registro). O id permite exportar só os contatos selecionados na tabela.
export interface ContactExportRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  traffic_type: string | null;
  tags: string[];
  first_seen: string | null;
}

interface UseContactsInput {
  search?: string;
  tagId?: string | null;
  source?: string | null;
  /** Lead = contato sem deal 'Cliente'; Cliente = tem ao menos um deal 'Cliente'. */
  leadType?: LeadTypeFilter | null;
  sort?: ContactSort;
  page?: number;
  pageSize?: number;
}

interface UseContactsResult {
  contacts: ContactWithTags[];
  total: number;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (
    input: Pick<Contact, 'phone'> & Partial<Pick<Contact, 'name' | 'email' | 'custom_fields'>> & { tag_ids?: string[] },
  ) => Promise<Contact | null>;
  update: (
    id: string,
    patch: Partial<Pick<Contact, 'name' | 'email' | 'phone' | 'custom_fields'>> & { tag_ids?: string[] },
  ) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
  assignTags: (contactIds: string[], tagIds: string[]) => Promise<void>;
  /** Busca TODOS os contatos que batem nos filtros atuais (sem paginação) para exportar em CSV. */
  exportContacts: () => Promise<ContactExportRow[]>;
}

const PAGE_SIZE_DEFAULT = 25;

// Resultado da resolução dos filtros que vivem fora da tabela contacts (tag e
// lead/cliente). `include` restringe a um conjunto de ids; `exclude` remove ids;
// 'empty' significa que nenhum contato pode casar (curto-circuito).
type IdFilter = { include: string[] | null; exclude: string[] | null } | 'empty';

export function useContacts({
  search = '',
  tagId = null,
  source = null,
  leadType = null,
  sort = 'recent',
  page = 1,
  pageSize = PAGE_SIZE_DEFAULT,
}: UseContactsInput = {}): UseContactsResult {
  const { userId } = useAppUser();
  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve os filtros que dependem de outras tabelas (tag via contact_tags,
  // lead/cliente via deals.lead_type) num par include/exclude aplicável tanto na
  // listagem paginada quanto no export. Lança em caso de erro de query.
  const resolveIdFilter = useCallback(async (): Promise<IdFilter> => {
    const supabase = getSupabase();
    let include: string[] | null = null;
    let exclude: string[] | null = null;

    if (tagId) {
      const { data: links, error: linksErr } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .eq('tag_id', tagId);
      if (linksErr) throw new Error(linksErr.message);
      include = (links ?? []).map((l) => l.contact_id as string);
      if (include.length === 0) return 'empty';
    }

    if (leadType) {
      // "Cliente" = contato com ao menos um deal marcado lead_type='Cliente'.
      const { data: dealRows, error: dealsErr } = await supabase
        .from('deals')
        .select('contact_id')
        .eq('lead_type', 'Cliente');
      if (dealsErr) throw new Error(dealsErr.message);
      const clienteIds = Array.from(
        new Set((dealRows ?? []).map((d) => d.contact_id as string)),
      );

      if (leadType === 'Cliente') {
        if (clienteIds.length === 0) return 'empty';
        const clienteSet = new Set(clienteIds);
        include = include ? include.filter((id) => clienteSet.has(id)) : clienteIds;
        if (include.length === 0) return 'empty';
      } else {
        // Lead = todos que NÃO são cliente.
        exclude = clienteIds;
      }
    }

    return { include, exclude };
  }, [tagId, leadType]);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // Filtros que vivem fora de contacts (tag, lead/cliente) viram include/exclude.
    let idFilter: IdFilter;
    try {
      idFilter = await resolveIdFilter();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao aplicar filtros.');
      setLoading(false);
      return;
    }
    if (idFilter === 'empty') {
      setContacts([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .range(from, to);

    // Ordenação (coluna "Primeiro registro" e nome também ordenáveis).
    if (sort === 'oldest') query = query.order('created_at', { ascending: true });
    else if (sort === 'name') query = query.order('name', { ascending: true, nullsFirst: false });
    else if (sort === 'first_seen') query = query.order('first_seen_at', { ascending: false });
    else query = query.order('created_at', { ascending: false });

    if (idFilter.include) {
      query = query.in('id', idFilter.include);
    }
    if (idFilter.exclude && idFilter.exclude.length > 0) {
      query = query.not('id', 'in', `(${idFilter.exclude.join(',')})`);
    }

    if (source) {
      query = query.eq('source', source);
    }

    if (search.trim()) {
      const pattern = `%${search.trim()}%`;
      query = query.or(`name.ilike.${pattern},phone.ilike.${pattern},email.ilike.${pattern}`);
    }

    const { data, error: err, count } = await query;
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    const ids = (data ?? []).map((c) => c.id as string);
    if (ids.length === 0) {
      setContacts([]);
      setTotal(count ?? 0);
      setLoading(false);
      return;
    }

    const { data: linkRows, error: linkErr } = await supabase
      .from('contact_tags')
      .select('contact_id, tag:tag_id(id, name, color, created_at, updated_at)')
      .in('contact_id', ids);
    if (linkErr) {
      setError(linkErr.message);
      setLoading(false);
      return;
    }

    const byContact = new Map<string, Tag[]>();
    for (const row of linkRows ?? []) {
      const contactId = row.contact_id as string;
      const tag = row.tag as unknown as Tag | null;
      if (!tag) continue;
      const arr = byContact.get(contactId) ?? [];
      arr.push(tag);
      byContact.set(contactId, arr);
    }

    // Origem: traffic_type do deal mais recente de cada contato (coluna Origem).
    const { data: dealRows } = await supabase
      .from('deals')
      .select('contact_id, traffic_type, created_at')
      .in('contact_id', ids)
      .order('created_at', { ascending: false });
    const trafficByContact = new Map<string, string | null>();
    for (const d of (dealRows ?? []) as Array<{ contact_id: string; traffic_type: string | null }>) {
      if (!trafficByContact.has(d.contact_id)) trafficByContact.set(d.contact_id, d.traffic_type);
    }

    const merged: ContactWithTags[] = (data ?? []).map((c) => ({
      ...(c as Contact),
      tags: byContact.get(c.id as string) ?? [],
      traffic_type: trafficByContact.get(c.id as string) ?? null,
    }));

    setContacts(merged);
    setTotal(count ?? 0);
    setLoading(false);
  }, [userId, search, source, sort, page, pageSize, resolveIdFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Export CSV: busca TODOS os contatos que batem nos filtros atuais (search,
  // tag, canal, lead/cliente), paginando por 1000 para não esbarrar no teto do
  // PostgREST, e enriquece com a origem (traffic_type do deal mais recente).
  const exportContacts = useCallback(async (): Promise<ContactExportRow[]> => {
    const supabase = getSupabase();
    const idFilter = await resolveIdFilter();
    if (idFilter === 'empty') return [];

    type RawRow = {
      id: string;
      name: string | null;
      phone: string | null;
      email: string | null;
      source: string | null;
      first_seen_at: string | null;
      created_at: string;
    };
    const rows: RawRow[] = [];
    const CHUNK = 1000;
    for (let offset = 0; ; offset += CHUNK) {
      let q = supabase
        .from('contacts')
        .select('id, name, phone, email, source, first_seen_at, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + CHUNK - 1);
      if (idFilter.include) q = q.in('id', idFilter.include);
      if (idFilter.exclude && idFilter.exclude.length > 0) {
        q = q.not('id', 'in', `(${idFilter.exclude.join(',')})`);
      }
      if (source) q = q.eq('source', source);
      if (search.trim()) {
        const pattern = `%${search.trim()}%`;
        q = q.or(`name.ilike.${pattern},phone.ilike.${pattern},email.ilike.${pattern}`);
      }
      const { data, error: err } = await q;
      if (err) throw new Error(err.message);
      const batch = (data ?? []) as RawRow[];
      rows.push(...batch);
      if (batch.length < CHUNK) break;
    }

    // Origem e tags por contato — em lotes de 300 ids para não estourar a URL.
    const trafficByContact = new Map<string, string | null>();
    const tagsByContact = new Map<string, string[]>();
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 300) {
      const slice = ids.slice(i, i + 300);
      const { data: dealRows } = await supabase
        .from('deals')
        .select('contact_id, traffic_type, created_at')
        .in('contact_id', slice)
        .order('created_at', { ascending: false });
      for (const d of (dealRows ?? []) as Array<{ contact_id: string; traffic_type: string | null }>) {
        if (!trafficByContact.has(d.contact_id)) trafficByContact.set(d.contact_id, d.traffic_type);
      }
      const { data: linkRows } = await supabase
        .from('contact_tags')
        .select('contact_id, tag:tag_id(name)')
        .in('contact_id', slice);
      for (const row of linkRows ?? []) {
        const tag = row.tag as unknown as { name: string } | null;
        if (!tag) continue;
        const contactId = row.contact_id as string;
        const arr = tagsByContact.get(contactId) ?? [];
        arr.push(tag.name);
        tagsByContact.set(contactId, arr);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      source: r.source,
      traffic_type: trafficByContact.get(r.id) ?? null,
      tags: tagsByContact.get(r.id) ?? [],
      first_seen: r.first_seen_at ?? r.created_at,
    }));
  }, [resolveIdFilter, source, search]);

  const create: UseContactsResult['create'] = async (input) => {
    if (!userId) return null;
    const { tag_ids = [], ...contactPayload } = input;
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('contacts')
      .insert({
        phone: contactPayload.phone,
        name: contactPayload.name ?? null,
        email: contactPayload.email ?? null,
        custom_fields: contactPayload.custom_fields ?? {},
      })
      .select()
      .single();
    if (err) {
      setError(err.message);
      throw new Error(translateContactError(err.message));
    }
    const created = data as Contact;
    if (tag_ids.length > 0) {
      await assignTagsTo([created.id], tag_ids);
    }
    await reload();
    return created;
  };

  const update: UseContactsResult['update'] = async (id, patch) => {
    if (!userId) return;
    const { tag_ids, ...rest } = patch;
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('contacts').update(rest).eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateContactError(err.message));
    }
    if (tag_ids) {
      // Replace the tag set: delete old links, insert new ones.
      await supabase.schema('whatsapp_hub').from('contact_tags').delete().eq('contact_id', id);
      if (tag_ids.length > 0) {
        await supabase
          .from('contact_tags')
          .insert(tag_ids.map((tag_id) => ({ contact_id: id, tag_id })));
      }
    }
    await reload();
  };

  const remove: UseContactsResult['remove'] = async (ids) => {
    if (ids.length === 0) return;
    const supabase = getSupabase();
    const { error: err } = await supabase.schema('whatsapp_hub').from('contacts').delete().in('id', ids);
    if (err) {
      setError(err.message);
      throw new Error(translateContactError(err.message));
    }
    await reload();
  };

  const assignTags: UseContactsResult['assignTags'] = async (contactIds, tagIds) => {
    if (!userId || contactIds.length === 0 || tagIds.length === 0) return;
    await assignTagsTo(contactIds, tagIds);
    await reload();
  };

  return { contacts, total, loading, error, reload, create, update, remove, assignTags, exportContacts };
}

async function assignTagsTo(contactIds: string[], tagIds: string[]) {
  const supabase = getSupabase();
  const rows = contactIds.flatMap((contact_id) =>
    tagIds.map((tag_id) => ({ contact_id, tag_id })),
  );
  // upsert handles duplicates — composite PK is (contact_id, tag_id).
  const { error } = await supabase
    .schema('whatsapp_hub')
    .from('contact_tags')
    .upsert(rows, { onConflict: 'contact_id,tag_id' });
  if (error) throw new Error(translateContactError(error.message));
}

// Maps the most common Postgres/PostgREST errors to actionable pt-BR messages
// so a non-technical operator sees "telefone já cadastrado" instead of a raw
// "duplicate key value violates unique constraint" string.
function translateContactError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('duplicate key') && lower.includes('phone')) {
    return 'Já existe um contato com este telefone.';
  }
  if (lower.includes('duplicate key')) {
    return 'Registro duplicado — verifique os dados informados.';
  }
  if (lower.includes('row-level security') || lower.includes('permission denied')) {
    return 'Você não tem permissão para esta ação.';
  }
  if (lower.includes('violates check constraint') || lower.includes('invalid input')) {
    return 'Dados inválidos — revise os campos e tente novamente.';
  }
  return message || 'Não foi possível concluir a operação.';
}
