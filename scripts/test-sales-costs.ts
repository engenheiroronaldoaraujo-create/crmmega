// ============================================================================
// Testes do faturamento líquido do dashboard (useSalesCosts).
// Rodar com: npx tsx scripts/test-sales-costs.ts
// ============================================================================

import assert from 'node:assert/strict';
import {
  EMPTY_COSTS, hasCosts, netRevenue, parseCosts, parseDecimal,
  type SalesCosts,
} from '../src/lib/salesCosts';

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

const costs = (over: Partial<SalesCosts>): SalesCosts => ({ ...EMPTY_COSTS, ...over });

// ---- netRevenue -------------------------------------------------------------
console.log('netRevenue:');

test('sem custos: líquido = bruto', () => {
  assert.equal(netRevenue(1000, 5, EMPTY_COSTS), 1000);
});
test('checkout 5% + imposto 10% sobre R$ 1.000 → R$ 850', () => {
  assert.equal(netRevenue(1000, 5, costs({ checkout_pct: 5, tax_pct: 10 })), 850);
});
test('custo fixo R$ 2,50 × 4 vendas abate R$ 10', () => {
  assert.equal(netRevenue(1000, 4, costs({ other_value: 2.5, other_kind: 'fixed' })), 990);
});
test('outros custos em %: soma aos percentuais (5+10+2 = 17%)', () => {
  assert.equal(netRevenue(1000, 4, costs({ checkout_pct: 5, tax_pct: 10, other_value: 2, other_kind: 'pct' })), 830);
});
test('cenário completo: 4,99% + 6% + R$ 2,50 fixo × 10 vendas de R$ 10.000', () => {
  // 10000 * (1 - 0.1099) - 25 = 8901 - 25 = 8876
  const n = netRevenue(10000, 10, costs({ checkout_pct: 4.99, tax_pct: 6, other_value: 2.5, other_kind: 'fixed' }));
  assert.ok(Math.abs(n - 8876) < 1e-9, `esperava 8876, veio ${n}`);
});
test('percentuais somados passam de 100% → trava em 100% (não inverte sinal)', () => {
  assert.equal(netRevenue(1000, 1, costs({ checkout_pct: 80, tax_pct: 80 })), 0);
});
test('custo fixo pode levar a líquido negativo (venda abaixo do custo)', () => {
  assert.equal(netRevenue(100, 10, costs({ other_value: 20, other_kind: 'fixed' })), -100);
});
test('bruto zero com custo fixo: líquido = -custos fixos', () => {
  assert.equal(netRevenue(0, 2, costs({ other_value: 5, other_kind: 'fixed' })), -10);
});
test('consistência da linha do card: custos = bruto - líquido', () => {
  const c = costs({ checkout_pct: 4.99, tax_pct: 6, other_value: 2.5, other_kind: 'fixed' });
  const gross = 12345.67;
  const net = netRevenue(gross, 7, c);
  const shownCosts = gross - net;
  assert.ok(Math.abs(shownCosts - (gross * 0.1099 + 17.5)) < 1e-9);
});

// ---- parseDecimal (entrada do form) ----------------------------------------
console.log('\nparseDecimal:');

test('vírgula decimal pt-BR: "4,99" → 4.99 (Number puro daria NaN→0)', () => {
  assert.equal(parseDecimal('4,99'), 4.99);
});
test('ponto decimal e inteiro funcionam', () => {
  assert.equal(parseDecimal('4.99'), 4.99);
  assert.equal(parseDecimal('6'), 6);
});
test('vazio, lixo e negativo → 0', () => {
  assert.equal(parseDecimal(''), 0);
  assert.equal(parseDecimal('abc'), 0);
  assert.equal(parseDecimal('-5'), 0);
  assert.equal(parseDecimal(null), 0);
});

// ---- parseCosts (jsonb do banco / form) ------------------------------------
console.log('\nparseCosts:');

test('jsonb vazio → custos zerados (hasCosts = false)', () => {
  const c = parseCosts({});
  assert.deepEqual(c, EMPTY_COSTS);
  assert.equal(hasCosts(c), false);
});
test('valores válidos passam intactos', () => {
  const c = parseCosts({ checkout_pct: 4.99, tax_pct: 6, other_value: 2.5, other_kind: 'fixed' });
  assert.deepEqual(c, { checkout_pct: 4.99, tax_pct: 6, other_value: 2.5, other_kind: 'fixed' });
  assert.equal(hasCosts(c), true);
});
test('percentual individual acima de 100 é clampado', () => {
  assert.equal(parseCosts({ checkout_pct: 250 }).checkout_pct, 100);
  assert.equal(parseCosts({ other_value: 250, other_kind: 'pct' }).other_value, 100);
});
test('custo fixo em R$ não tem teto de 100', () => {
  assert.equal(parseCosts({ other_value: 250, other_kind: 'fixed' }).other_value, 250);
});
test('other_kind inválido cai em fixed; negativos viram 0', () => {
  const c = parseCosts({ checkout_pct: -3, other_value: -1, other_kind: 'banana' });
  assert.equal(c.checkout_pct, 0);
  assert.equal(c.other_value, 0);
  assert.equal(c.other_kind, 'fixed');
});
test('strings numéricas do jsonb (com vírgula) são aceitas', () => {
  const c = parseCosts({ checkout_pct: '4,99', tax_pct: '6' });
  assert.equal(c.checkout_pct, 4.99);
  assert.equal(c.tax_pct, 6);
});

// ---- Integração: mesmo caminho do DashboardPage ----------------------------
console.log('\nIntegração (caminho do card):');

test('form com vírgula → parse → save-shape → netRevenue no card', () => {
  // Simula o que o SalesCostsForm envia e o card calcula.
  const fromForm = parseCosts({
    checkout_pct: parseDecimal('4,99'),
    tax_pct: parseDecimal('6'),
    other_value: parseDecimal('2,50'),
    other_kind: 'fixed',
  });
  const gross = 10000;
  const count = 10;
  const net = hasCosts(fromForm) ? netRevenue(gross, count, fromForm) : null;
  assert.ok(net !== null && Math.abs(net - 8876) < 1e-9, `esperava 8876, veio ${net}`);
});
test('tudo zerado → card não exibe líquido (netValue null)', () => {
  const fromForm = parseCosts({ checkout_pct: 0, tax_pct: 0, other_value: 0, other_kind: 'fixed' });
  assert.equal(hasCosts(fromForm), false);
});

console.log(`\n${passed} testes passaram ✅`);
