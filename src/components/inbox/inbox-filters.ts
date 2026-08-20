import type { ConversationWithContact } from '@/types/inbox';

// Estado dos filtros do inbox (Módulo 7). A caixa de filtros segue o mesmo
// padrão do funil comercial: botão "Filtros" que abre um grid de campos +
// seletor de ordenação. Só entram campos que se aplicam à conversa (sem campos
// de deal como valor/produto/compra).
export type ChannelFilter = 'all' | 'whatsapp' | 'instagram' | 'uazapi';
export type Atendente = 'ia' | 'humano';
export type StatusBucket = 'abertas' | 'fechadas' | 'arquivadas';
export type JanelaFilter = 'any' | 'dentro' | 'fora';
export type TipoFilter = 'any' | 'lead' | 'cliente';

export interface InboxFilterState {
  // Campos de texto (espelham o funil: contato do lead).
  nome: string;
  email: string;
  telefone: string;
  empresa: string;
  // Última interação = last_message_at da conversa (intervalo de datas).
  interacaoDe: string;
  interacaoAte: string;
  // Eixos históricos do inbox.
  channel: ChannelFilter;
  atendente: Atendente[]; // vazio = qualquer
  status: StatusBucket[]; // default ['abertas']; vazio = qualquer
  assigned: string | 'unassigned' | 'any';
  tagIds: string[]; // any-match; vazio = qualquer
  janela: JanelaFilter;
  tipo: TipoFilter;
}

export const DEFAULT_FILTERS: InboxFilterState = {
  nome: '',
  email: '',
  telefone: '',
  empresa: '',
  interacaoDe: '',
  interacaoAte: '',
  channel: 'all',
  atendente: [],
  status: ['abertas'],
  assigned: 'any',
  tagIds: [],
  janela: 'any',
  tipo: 'any',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Bucket de status derivado: arquivada domina; senão closed → fechadas; senão
// aberta (ai_active | human_active).
function statusBucket(c: ConversationWithContact): StatusBucket {
  if (c.archived) return 'arquivadas';
  if (c.status === 'closed') return 'fechadas';
  return 'abertas';
}

export function isWithinWindow(c: ConversationWithContact, now: number): boolean {
  return Boolean(c.lastInboundAt) && now - new Date(c.lastInboundAt as string).getTime() < DAY_MS;
}

// Canal agregado da conversa: distingue WhatsApp oficial (Meta/zernio) de UAZAPI.
function convChannel(c: ConversationWithContact): ChannelFilter {
  if (c.channel === 'instagram') return 'instagram';
  if (c.channel === 'whatsapp') return c.provider === 'uazapi' ? 'uazapi' : 'whatsapp';
  return 'all';
}

// Colunas `date`/timestamp vs input yyyy-mm-dd — compara no fuso LOCAL. Sem isso
// `new Date("yyyy-mm-dd")` parseia como meia-noite UTC e o filtro exclui o dia
// no fuso do Brasil (UTC-3). (Mesma regra do funilFilterLogic.)
function inDateRange(ts: string | null | undefined, de: string, ate: string): boolean {
  if (!de && !ate) return true;
  if (!ts) return false;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(ts) ? new Date(`${ts}T00:00:00`).getTime() : new Date(ts).getTime();
  if (de && t < new Date(`${de}T00:00:00`).getTime()) return false;
  if (ate && t > new Date(`${ate}T23:59:59.999`).getTime()) return false;
  return true;
}

// Predicado central: uma conversa passa se satisfaz TODOS os eixos ativos (AND).
export function matchesFilters(
  c: ConversationWithContact,
  f: InboxFilterState,
  now: number,
): boolean {
  const nome = f.nome.trim().toLowerCase();
  if (nome && !(c.contact?.name ?? '').toLowerCase().includes(nome)) return false;

  const email = f.email.trim().toLowerCase();
  if (email && !(c.contact?.email ?? '').toLowerCase().includes(email)) return false;

  const fone = f.telefone.replace(/\D/g, '');
  if (fone && !(c.contact?.phone ?? '').replace(/\D/g, '').includes(fone)) return false;

  const empresa = f.empresa.trim().toLowerCase();
  if (empresa) {
    const comp = typeof c.contact?.custom_fields?.company === 'string' ? c.contact.custom_fields.company : '';
    if (!comp.toLowerCase().includes(empresa)) return false;
  }

  if (!inDateRange(c.last_message_at, f.interacaoDe, f.interacaoAte)) return false;

  if (f.channel !== 'all' && convChannel(c) !== f.channel) return false;

  if (f.status.length > 0 && !f.status.includes(statusBucket(c))) return false;

  if (f.atendente.length > 0) {
    const want: string[] = f.atendente.map((a) => (a === 'ia' ? 'ai_active' : 'human_active'));
    if (!want.includes(c.status)) return false;
  }

  if (f.assigned === 'unassigned') {
    if (c.assigned_to) return false;
  } else if (f.assigned !== 'any') {
    if (c.assigned_to !== f.assigned) return false;
  }

  if (f.tagIds.length > 0) {
    const hit = c.tagIds.some((t) => f.tagIds.includes(t));
    if (!hit) return false;
  }

  if (f.tipo !== 'any') {
    if (f.tipo === 'cliente' && !c.isCliente) return false;
    if (f.tipo === 'lead' && c.isCliente) return false;
  }

  if (f.janela !== 'any') {
    const within = isWithinWindow(c, now);
    if (f.janela === 'dentro' && !within) return false;
    if (f.janela === 'fora' && within) return false;
  }

  return true;
}

// Quantos eixos estão ativos — alimenta o badge do botão Filtros.
export function activeFilterCount(f: InboxFilterState): number {
  let n = 0;
  if (f.nome.trim()) n++;
  if (f.email.trim()) n++;
  if (f.telefone.trim()) n++;
  if (f.empresa.trim()) n++;
  if (f.interacaoDe || f.interacaoAte) n++;
  if (f.channel !== 'all') n++;
  if (f.atendente.length > 0) n++;
  // status conta como ativo só quando difere do default (['abertas']).
  const isDefaultStatus = f.status.length === 1 && f.status[0] === 'abertas';
  if (!isDefaultStatus) n++;
  if (f.assigned !== 'any') n++;
  if (f.tagIds.length > 0) n++;
  if (f.janela !== 'any') n++;
  if (f.tipo !== 'any') n++;
  return n;
}

// ---- Ordenação --------------------------------------------------------------

export type InboxSort = 'recente' | 'antiga' | 'nao_lidas' | 'alfabetica';

export const INBOX_SORT_LABEL: Record<InboxSort, string> = {
  recente: 'Mais recentes',
  antiga: 'Mais antigas',
  nao_lidas: 'Não lidas primeiro',
  alfabetica: 'Ordem alfabética (A–Z)',
};

function lastAt(c: ConversationWithContact): number {
  return c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
}

function convDisplayName(c: ConversationWithContact): string {
  return (c.contact?.name?.trim() || c.contact?.phone || '').toLowerCase();
}

export function sortConversations(
  list: ConversationWithContact[],
  sort: InboxSort,
): ConversationWithContact[] {
  const arr = [...list];
  switch (sort) {
    case 'antiga':
      return arr.sort((a, b) => lastAt(a) - lastAt(b));
    case 'nao_lidas':
      return arr.sort(
        (a, b) => (b.unread_count > 0 ? 1 : 0) - (a.unread_count > 0 ? 1 : 0) || lastAt(b) - lastAt(a),
      );
    case 'alfabetica':
      return arr.sort((a, b) => convDisplayName(a).localeCompare(convDisplayName(b), 'pt-BR'));
    case 'recente':
    default:
      return arr.sort((a, b) => lastAt(b) - lastAt(a));
  }
}

// ---- Persistência em querystring ------------------------------------------
// Namespace f* para não colidir com ?conversation= / ?contact= já usados.
export function readFiltersFromParams(sp: URLSearchParams): InboxFilterState {
  const csv = (v: string | null): string[] => (v ? v.split(',').filter(Boolean) : []);
  const ch = sp.get('fch');
  const channel: ChannelFilter =
    ch === 'whatsapp' || ch === 'instagram' || ch === 'uazapi' ? ch : 'all';
  const atendente = csv(sp.get('fat')).filter(
    (v): v is Atendente => v === 'ia' || v === 'humano',
  );
  const status = sp.has('fst')
    ? csv(sp.get('fst')).filter(
        (v): v is StatusBucket => v === 'abertas' || v === 'fechadas' || v === 'arquivadas',
      )
    : DEFAULT_FILTERS.status;
  const assigned = sp.get('fas') ?? 'any';
  const tagIds = csv(sp.get('ftg'));
  const jw = sp.get('fjw');
  const janela: JanelaFilter = jw === 'dentro' || jw === 'fora' ? jw : 'any';
  const tp = sp.get('ftp');
  const tipo: TipoFilter = tp === 'lead' || tp === 'cliente' ? tp : 'any';
  return {
    nome: sp.get('fno') ?? '',
    email: sp.get('fem') ?? '',
    telefone: sp.get('fte') ?? '',
    empresa: sp.get('fco') ?? '',
    interacaoDe: sp.get('fide') ?? '',
    interacaoAte: sp.get('fiate') ?? '',
    channel,
    atendente,
    status,
    assigned,
    tagIds,
    janela,
    tipo,
  };
}

// Aplica os params de filtro num objeto de params existente (preserva os
// demais, ex.: conversation). Só grava o que difere do default.
export function writeFiltersToParams(
  sp: URLSearchParams,
  f: InboxFilterState,
): URLSearchParams {
  const next = new URLSearchParams(sp);
  const setOrDel = (key: string, val: string, on: boolean) => {
    if (on) next.set(key, val);
    else next.delete(key);
  };
  setOrDel('fno', f.nome.trim(), f.nome.trim() !== '');
  setOrDel('fem', f.email.trim(), f.email.trim() !== '');
  setOrDel('fte', f.telefone.trim(), f.telefone.trim() !== '');
  setOrDel('fco', f.empresa.trim(), f.empresa.trim() !== '');
  setOrDel('fide', f.interacaoDe, f.interacaoDe !== '');
  setOrDel('fiate', f.interacaoAte, f.interacaoAte !== '');
  setOrDel('fch', f.channel, f.channel !== 'all');
  setOrDel('fat', f.atendente.join(','), f.atendente.length > 0);
  const isDefaultStatus = f.status.length === 1 && f.status[0] === 'abertas';
  setOrDel('fst', f.status.join(','), !isDefaultStatus);
  setOrDel('fas', f.assigned, f.assigned !== 'any');
  setOrDel('ftg', f.tagIds.join(','), f.tagIds.length > 0);
  setOrDel('fjw', f.janela, f.janela !== 'any');
  setOrDel('ftp', f.tipo, f.tipo !== 'any');
  return next;
}
