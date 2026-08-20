// ============================================================================
// Testes da lógica de filtros + ordenação do Funil (funilFilterLogic.ts).
// Rodar com: npx tsx scripts/test-funil-filters.ts
// (rodar com TZ=America/Sao_Paulo para cobrir o bug de fuso em colunas `date`)
// ============================================================================

import assert from 'node:assert/strict';
import {
  applyFunilFilters, countActiveFilters, inDateRange, sortFunilDeals,
  EMPTY_FILTERS,
  type ContactConvInfo, type FunilFilterState,
} from '../src/components/funil/funilFilterLogic';
import type { Deal } from '../src/types/crm';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

// Deal mínimo com defaults; sobrescreve via partial.
let seq = 0;
function makeDeal(over: Partial<Deal> & { contact?: Partial<NonNullable<Deal['contact']>> } = {}): Deal {
  seq++;
  const { contact, ...rest } = over;
  return {
    id: over.id ?? `deal-${seq}`,
    contact_id: over.contact_id ?? `contact-${seq}`,
    pipeline_id: 'p1',
    stage_id: 's1',
    title: `Negócio ${seq}`,
    value: 0,
    currency: 'BRL',
    status: 'open',
    expected_close: null,
    won_at: null,
    lost_at: null,
    lost_reason: null,
    owner_id: null,
    lead_type: 'Lead',
    temperature: 'Frio',
    last_purchase_at: null,
    first_contact_at: null,
    first_response_at: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    traffic_type: null,
    origin_channel: null,
    archived_at: null,
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    tags: [],
    products: [],
    ...rest,
    contact: {
      id: over.contact_id ?? `contact-${seq}`,
      name: null, phone: '', email: null, custom_fields: null,
      ...(contact ?? {}),
    },
  } as Deal;
}

const f = (over: Partial<FunilFilterState>): FunilFilterState => ({ ...EMPTY_FILTERS, ...over });
const noConvs: Record<string, ContactConvInfo[]> = {};
const apply = (
  deals: Deal[], over: Partial<FunilFilterState>,
  next: Record<string, string> = {}, convs: Record<string, ContactConvInfo[]> = noConvs,
) => applyFunilFilters(deals, f(over), next, convs).map((d) => d.id);

console.log(`TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone} offset=${new Date().getTimezoneOffset()}min`);

// ---- inDateRange / bug do fuso em coluna `date` -----------------------------
console.log('\ninDateRange (datas):');

test('BUG corrigido: date-only "2026-08-05" cai dentro do range 05/08–05/08', () => {
  assert.equal(inDateRange('2026-08-05', '2026-08-05', '2026-08-05'), true);
});
test('date-only fora do range é excluído', () => {
  assert.equal(inDateRange('2026-08-04', '2026-08-05', ''), false);
  assert.equal(inDateRange('2026-08-06', '', '2026-08-05'), false);
});
test('timestamptz dentro do dia local é incluído', () => {
  // 23:30 local do dia 05
  const local = new Date('2026-08-05T23:30:00').toISOString();
  assert.equal(inDateRange(local, '2026-08-05', '2026-08-05'), true);
});
test('sem valor de data (null) é excluído quando há range', () => {
  assert.equal(inDateRange(null, '2026-08-05', ''), false);
});
test('sem range, tudo passa (inclusive null)', () => {
  assert.equal(inDateRange(null, '', ''), true);
  assert.equal(inDateRange('2020-01-01', '', ''), true);
});
test('apenas "de" / apenas "até" funcionam isolados', () => {
  assert.equal(inDateRange('2026-08-10', '2026-08-05', ''), true);
  assert.equal(inDateRange('2026-08-01', '', '2026-08-05'), true);
});

// ---- Filtros de texto -------------------------------------------------------
console.log('\nFiltros de texto:');

const dJoao = makeDeal({ id: 'joao', contact: { name: 'João Silva', email: 'JOAO@empresa.com', phone: '+55 (11) 98888-7777', custom_fields: { company: 'Acme LTDA' } } });
const dMaria = makeDeal({ id: 'maria', contact: { name: 'Maria Souza', email: 'maria@outra.com', phone: '+5521999990000', custom_fields: { company: 'Beta Corp' } } });

test('nome: case-insensitive, substring', () => {
  assert.deepEqual(apply([dJoao, dMaria], { nome: 'joão' }), ['joao']);
  assert.deepEqual(apply([dJoao, dMaria], { nome: '  ' }), ['joao', 'maria']); // só espaços = sem filtro
});
test('email: case-insensitive', () => {
  assert.deepEqual(apply([dJoao, dMaria], { email: 'joao@' }), ['joao']);
});
test('telefone: ignora máscara/pontuação dos dois lados', () => {
  assert.deepEqual(apply([dJoao, dMaria], { telefone: '(11) 98888' }), ['joao']);
  assert.deepEqual(apply([dJoao, dMaria], { telefone: '21 99999' }), ['maria']);
});
test('empresa: busca em custom_fields.company', () => {
  assert.deepEqual(apply([dJoao, dMaria], { empresa: 'acme' }), ['joao']);
  assert.deepEqual(apply([dJoao, dMaria], { empresa: 'inexistente' }), []);
});

// ---- Datas nos filtros do board --------------------------------------------
console.log('\nDatas do board:');

test('data de compra (coluna date) no próprio dia — cenário do bug reportado', () => {
  const d = makeDeal({ id: 'compra-hoje', last_purchase_at: '2026-08-05' });
  assert.deepEqual(apply([d], { compraDe: '2026-08-05', compraAte: '2026-08-05' }), ['compra-hoje']);
});
test('última interação usa a conversa MAIS RECENTE entre várias', () => {
  const d = makeDeal({ id: 'multi', contact_id: 'c-multi' });
  const convs = {
    'c-multi': [
      { channel: 'whatsapp', provider: 'zernio', last_message_at: '2026-07-01T10:00:00.000Z' },
      { channel: 'instagram', provider: null, last_message_at: '2026-08-04T10:00:00.000Z' },
    ] as ContactConvInfo[],
  };
  assert.deepEqual(apply([d], { interacaoDe: '2026-08-01' }, {}, convs), ['multi']);
  assert.deepEqual(apply([d], { interacaoAte: '2026-07-31' }, {}, convs), []); // última foi depois
});
test('próxima ação: filtra pelo due_at pendente; sem ação = excluído', () => {
  const com = makeDeal({ id: 'com-acao' });
  const sem = makeDeal({ id: 'sem-acao' });
  const next = { 'com-acao': '2026-08-10T14:00:00.000Z' };
  assert.deepEqual(apply([com, sem], { proximaAcaoDe: '2026-08-10', proximaAcaoAte: '2026-08-10' }, next), ['com-acao']);
});

// ---- Tags / produtos / selects ---------------------------------------------
console.log('\nTags, produtos e selects:');

test('tags: OR entre as selecionadas', () => {
  const a = makeDeal({ id: 'a', tags: [{ id: 't1', name: 'VIP', color: '#fff' }] });
  const b = makeDeal({ id: 'b', tags: [{ id: 't2', name: 'Frio', color: '#fff' }] });
  assert.deepEqual(apply([a, b], { tagIds: ['t1'] }), ['a']);
  assert.deepEqual(apply([a, b], { tagIds: ['t1', 't2'] }), ['a', 'b']);
});
test('produtos: OR entre os selecionados', () => {
  const a = makeDeal({ id: 'a', products: [{ id: 'p1', name: 'Curso' }] });
  const b = makeDeal({ id: 'b', products: [] });
  assert.deepEqual(apply([a, b], { productIds: ['p1'] }), ['a']);
});
test('temperatura e lead_type', () => {
  const quente = makeDeal({ id: 'q', temperature: 'Quente' });
  const frioCliente = makeDeal({ id: 'fc', temperature: 'Frio', lead_type: 'Cliente' });
  assert.deepEqual(apply([quente, frioCliente], { temperatura: 'Quente' }), ['q']);
  assert.deepEqual(apply([quente, frioCliente], { leadType: 'Cliente' }), ['fc']);
});

// ---- Valor ------------------------------------------------------------------
console.log('\nValor:');

test('valor mín/máx inclusivos; null vira 0', () => {
  const zero = makeDeal({ id: 'zero', value: null });
  const cem = makeDeal({ id: 'cem', value: 100 });
  const mil = makeDeal({ id: 'mil', value: 1000 });
  assert.deepEqual(apply([zero, cem, mil], { valorMin: '100' }), ['cem', 'mil']);
  assert.deepEqual(apply([zero, cem, mil], { valorMax: '100' }), ['zero', 'cem']);
  assert.deepEqual(apply([zero, cem, mil], { valorMin: '100', valorMax: '100' }), ['cem']);
});

// ---- Origem / canal ---------------------------------------------------------
console.log('\nOrigem e canal:');

test('origem: meta_ads agrega instagram_ads/facebook_ads/meta_ads', () => {
  const ig = makeDeal({ id: 'ig', origin_channel: 'instagram_ads', traffic_type: 'pago' });
  const gg = makeDeal({ id: 'gg', origin_channel: 'google_ads', traffic_type: 'pago' });
  const org = makeDeal({ id: 'org', traffic_type: 'organico', origin_channel: 'instagram' });
  assert.deepEqual(apply([ig, gg, org], { origem: 'meta_ads' }), ['ig']);
  assert.deepEqual(apply([ig, gg, org], { origem: 'google_ads' }), ['gg']);
  assert.deepEqual(apply([ig, gg, org], { origem: 'organico' }), ['org']);
  assert.deepEqual(apply([ig, gg, org], { origem: 'linkedin_ads' }), []);
});
test('canal: distingue whatsapp oficial × uazapi × instagram; basta 1 conversa bater', () => {
  const d = makeDeal({ id: 'd', contact_id: 'cc' });
  const convs = {
    cc: [
      { channel: 'whatsapp', provider: 'uazapi', last_message_at: null },
      { channel: 'instagram', provider: null, last_message_at: null },
    ] as ContactConvInfo[],
  };
  assert.deepEqual(apply([d], { canal: 'uazapi' }, {}, convs), ['d']);
  assert.deepEqual(apply([d], { canal: 'instagram' }, {}, convs), ['d']);
  assert.deepEqual(apply([d], { canal: 'whatsapp' }, {}, convs), []); // só tem uazapi, não oficial
});
test('canal: contato sem conversa é excluído quando há filtro de canal', () => {
  const d = makeDeal({ id: 'd' });
  assert.deepEqual(apply([d], { canal: 'whatsapp' }), []);
});

// ---- countActiveFilters -----------------------------------------------------
console.log('\ncountActiveFilters:');

test('conta ranges como 1 e ignora vazios', () => {
  assert.equal(countActiveFilters(EMPTY_FILTERS), 0);
  assert.equal(countActiveFilters(f({ compraDe: '2026-08-01', compraAte: '2026-08-05', nome: 'x' })), 2);
  assert.equal(countActiveFilters(f({ valorMin: '10', canal: 'uazapi', tagIds: ['t'] })), 3);
});

// ---- Ordenação --------------------------------------------------------------
console.log('\nOrdenação:');

const s1 = makeDeal({ id: 's1', value: 50, created_at: '2026-08-01T10:00:00.000Z', contact: { name: 'Carlos' } });
const s2 = makeDeal({ id: 's2', value: 500, created_at: '2026-08-03T10:00:00.000Z', contact: { name: 'ana' } });
const s3 = makeDeal({ id: 's3', value: 5, created_at: '2026-08-02T10:00:00.000Z', contact: { name: 'Bruno' } });

test('recente (padrão): mais novos primeiro', () => {
  assert.deepEqual(sortFunilDeals([s1, s2, s3], 'recente').map((d) => d.id), ['s2', 's3', 's1']);
});
test('valor_desc: maior → menor', () => {
  assert.deepEqual(sortFunilDeals([s1, s2, s3], 'valor_desc').map((d) => d.id), ['s2', 's1', 's3']);
});
test('valor_asc: menor → maior', () => {
  assert.deepEqual(sortFunilDeals([s1, s2, s3], 'valor_asc').map((d) => d.id), ['s3', 's1', 's2']);
});
test('alfabética: por nome do lead, case-insensitive (pt-BR)', () => {
  assert.deepEqual(sortFunilDeals([s1, s2, s3], 'alfabetica').map((d) => d.id), ['s2', 's3', 's1']);
});
test('alfabética: sem nome cai no telefone/título', () => {
  const semNome = makeDeal({ id: 'fone', title: 'ZZZ', contact: { name: null, phone: '+5511' } });
  assert.equal(sortFunilDeals([semNome], 'alfabetica')[0].id, 'fone');
});
test('não muta o array original', () => {
  const arr = [s1, s2, s3];
  sortFunilDeals(arr, 'valor_desc');
  assert.deepEqual(arr.map((d) => d.id), ['s1', 's2', 's3']);
});

console.log(`\n${passed} testes passaram ✅`);
