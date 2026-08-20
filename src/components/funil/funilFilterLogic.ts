// ============================================================================
// Lógica pura de filtros e ordenação do board do funil comercial.
// Sem dependência de React/Supabase para poder ser testada isoladamente
// (scripts/test-funil-filters.ts).
// ============================================================================

import type { Deal } from '@/types/crm';

// Resumo de UMA conversa do contato (canal + última interação). Um contato pode
// ter várias conversas (WhatsApp Meta, UAZAPI, Instagram) — os filtros recebem
// a lista completa por contato.
export interface ContactConvInfo {
  channel: string | null;
  last_message_at: string | null;
  provider: string | null;
}

// ---- Estado dos filtros -----------------------------------------------------

export interface FunilFilterState {
  nome: string;
  email: string;
  telefone: string;
  empresa: string;
  compraDe: string;      // last_purchase_at >= (yyyy-mm-dd)
  compraAte: string;
  interacaoDe: string;   // conversa.last_message_at (mais recente entre as conversas)
  interacaoAte: string;
  proximaAcaoDe: string; // due_at da próxima ação pendente
  proximaAcaoAte: string;
  tagIds: string[];
  temperatura: '' | 'Frio' | 'Morno' | 'Quente';
  leadType: '' | 'Lead' | 'Cliente';
  productIds: string[];
  valorMin: string;
  valorMax: string;
  origem: '' | 'organico' | 'meta_ads' | 'google_ads' | 'linkedin_ads';
  canal: '' | 'instagram' | 'whatsapp' | 'uazapi';
}

export const EMPTY_FILTERS: FunilFilterState = {
  nome: '', email: '', telefone: '', empresa: '',
  compraDe: '', compraAte: '', interacaoDe: '', interacaoAte: '',
  proximaAcaoDe: '', proximaAcaoAte: '',
  tagIds: [], temperatura: '', leadType: '', productIds: [],
  valorMin: '', valorMax: '', origem: '', canal: '',
};

export function countActiveFilters(f: FunilFilterState): number {
  let n = 0;
  if (f.nome.trim()) n++;
  if (f.email.trim()) n++;
  if (f.telefone.trim()) n++;
  if (f.empresa.trim()) n++;
  if (f.compraDe || f.compraAte) n++;
  if (f.interacaoDe || f.interacaoAte) n++;
  if (f.proximaAcaoDe || f.proximaAcaoAte) n++;
  if (f.tagIds.length) n++;
  if (f.temperatura) n++;
  if (f.leadType) n++;
  if (f.productIds.length) n++;
  if (f.valorMin || f.valorMax) n++;
  if (f.origem) n++;
  if (f.canal) n++;
  return n;
}

// ---- Datas ------------------------------------------------------------------

// Colunas `date` do Postgres chegam como "yyyy-mm-dd". `new Date("yyyy-mm-dd")`
// parseia como MEIA-NOITE UTC — no fuso do Brasil (UTC-3) isso vira 21h do dia
// ANTERIOR, e o filtro exclui compras do próprio dia. Forçamos o parse no fuso
// local anexando a hora.
function toLocalTime(ts: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return new Date(`${ts}T00:00:00`).getTime();
  return new Date(ts).getTime();
}

// Data (yyyy-mm-dd do input) vs timestamp — compara no fuso local.
export function inDateRange(ts: string | null | undefined, de: string, ate: string): boolean {
  if (!de && !ate) return true;
  if (!ts) return false;
  const t = toLocalTime(ts);
  if (de && t < new Date(`${de}T00:00:00`).getTime()) return false;
  if (ate && t > new Date(`${ate}T23:59:59.999`).getTime()) return false;
  return true;
}

// ---- Origem / canal ---------------------------------------------------------

// Origem agregada do filtro a partir do rastreio UTM do deal.
export function matchOrigem(deal: Deal, origem: FunilFilterState['origem']): boolean {
  if (!origem) return true;
  const oc = deal.origin_channel ?? '';
  if (origem === 'organico') return deal.traffic_type === 'organico';
  if (origem === 'meta_ads') return ['meta_ads', 'instagram_ads', 'facebook_ads'].includes(oc);
  if (origem === 'google_ads') return oc === 'google_ads';
  return oc === 'linkedin_ads';
}

// Canal agregado de uma conversa: distingue WhatsApp oficial (Meta) de UAZAPI.
function convCanal(conv: ContactConvInfo): '' | 'instagram' | 'whatsapp' | 'uazapi' {
  if (conv.channel === 'instagram') return 'instagram';
  if (conv.channel === 'whatsapp') return conv.provider === 'uazapi' ? 'uazapi' : 'whatsapp';
  return '';
}

// Última interação do contato = mais recente entre todas as suas conversas.
function lastInteractionAt(convs: ContactConvInfo[]): string | null {
  let max: string | null = null;
  for (const c of convs) {
    if (c.last_message_at && (!max || c.last_message_at > max)) max = c.last_message_at;
  }
  return max;
}

// ---- Filtro principal -------------------------------------------------------

export function applyFunilFilters(
  deals: Deal[],
  f: FunilFilterState,
  nextActionByDeal: Record<string, string>,
  convsByContact: Record<string, ContactConvInfo[]>,
): Deal[] {
  const nome = f.nome.trim().toLowerCase();
  const email = f.email.trim().toLowerCase();
  const fone = f.telefone.replace(/\D/g, '');
  const empresa = f.empresa.trim().toLowerCase();
  const vMin = f.valorMin === '' ? null : Number(f.valorMin);
  const vMax = f.valorMax === '' ? null : Number(f.valorMax);

  return deals.filter((d) => {
    const c = d.contact;
    if (nome && !(c?.name ?? '').toLowerCase().includes(nome)) return false;
    if (email && !(c?.email ?? '').toLowerCase().includes(email)) return false;
    if (fone && !(c?.phone ?? '').replace(/\D/g, '').includes(fone)) return false;
    if (empresa) {
      const comp = typeof c?.custom_fields?.company === 'string' ? c.custom_fields.company : '';
      if (!comp.toLowerCase().includes(empresa)) return false;
    }
    if (!inDateRange(d.last_purchase_at, f.compraDe, f.compraAte)) return false;
    const convs = convsByContact[d.contact_id] ?? [];
    if (!inDateRange(lastInteractionAt(convs), f.interacaoDe, f.interacaoAte)) return false;
    if (!inDateRange(nextActionByDeal[d.id] ?? null, f.proximaAcaoDe, f.proximaAcaoAte)) return false;
    if (f.tagIds.length && !f.tagIds.some((t) => (d.tags ?? []).some((dt) => dt.id === t))) return false;
    if (f.temperatura && d.temperature !== f.temperatura) return false;
    if (f.leadType && d.lead_type !== f.leadType) return false;
    if (f.productIds.length && !f.productIds.some((p) => (d.products ?? []).some((dp) => dp.id === p))) return false;
    const valor = Number(d.value) || 0;
    if (vMin != null && valor < vMin) return false;
    if (vMax != null && valor > vMax) return false;
    if (!matchOrigem(d, f.origem)) return false;
    // Canal: basta UMA das conversas do contato bater com o canal filtrado.
    if (f.canal && !convs.some((cv) => convCanal(cv) === f.canal)) return false;
    return true;
  });
}

// ---- Ordenação --------------------------------------------------------------

export type FunilSort = 'recente' | 'valor_desc' | 'valor_asc' | 'alfabetica';

export const FUNIL_SORT_LABEL: Record<FunilSort, string> = {
  recente: 'Mais recentes',
  valor_desc: 'Maior valor',
  valor_asc: 'Menor valor',
  alfabetica: 'Ordem alfabética (A–Z)',
};

// Nome exibido no card (mesma regra do DealCard: nome do lead → telefone → título).
function dealDisplayName(d: Deal): string {
  return (d.contact?.name?.trim() || d.contact?.phone || d.title || '').toLowerCase();
}

export function sortFunilDeals(deals: Deal[], sort: FunilSort): Deal[] {
  const list = [...deals];
  switch (sort) {
    case 'valor_desc':
      return list.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    case 'valor_asc':
      return list.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
    case 'alfabetica':
      return list.sort((a, b) => dealDisplayName(a).localeCompare(dealDisplayName(b), 'pt-BR'));
    case 'recente':
    default:
      // Mais recentes primeiro (padrão do board).
      return list.sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));
  }
}
