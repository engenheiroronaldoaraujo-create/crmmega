// ----------------------------------------------------------------------------
// Lógica pura do faturamento líquido (custos por venda do dashboard).
// Sem dependência de React/Supabase — testável em scripts/test-sales-costs.ts.
// ----------------------------------------------------------------------------

export interface SalesCosts {
  checkout_pct: number;        // taxa do checkout, em %
  tax_pct: number;             // imposto, em %
  other_value: number;         // outros custos por venda (R$ fixo ou %)
  other_kind: 'fixed' | 'pct';
}

export const EMPTY_COSTS: SalesCosts = {
  checkout_pct: 0, tax_pct: 0, other_value: 0, other_kind: 'fixed',
};

export function hasCosts(c: SalesCosts): boolean {
  return c.checkout_pct > 0 || c.tax_pct > 0 || c.other_value > 0;
}

// Receita líquida do período: percentuais incidem sobre o bruto; custo fixo é
// multiplicado pela quantidade de vendas. O somatório de percentuais é limitado
// a 100% (mais que isso é erro de configuração, não desconto real); o custo
// fixo pode legitimamente levar o líquido a negativo (venda abaixo do custo).
export function netRevenue(gross: number, salesCount: number, c: SalesCosts): number {
  const pct = Math.min(100, c.checkout_pct + c.tax_pct + (c.other_kind === 'pct' ? c.other_value : 0));
  const fixed = c.other_kind === 'fixed' ? c.other_value * salesCount : 0;
  return gross * (1 - pct / 100) - fixed;
}

// Entrada do usuário → número: aceita vírgula decimal pt-BR ("4,99"), rejeita
// negativos/inválidos (→ 0). Number("4,99") é NaN — sem isso o custo seria
// salvo como 0 silenciosamente.
export function parseDecimal(v: unknown): number {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Normaliza o jsonb do banco/form. Percentuais têm teto de 100 (evita líquido
// negativo por erro de digitação); o custo fixo em R$ não tem teto.
export function parseCosts(raw: unknown): SalesCosts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = o.other_kind === 'pct' ? 'pct' : 'fixed';
  const pct = (v: unknown) => Math.min(100, parseDecimal(v));
  return {
    checkout_pct: pct(o.checkout_pct),
    tax_pct: pct(o.tax_pct),
    other_value: kind === 'pct' ? pct(o.other_value) : parseDecimal(o.other_value),
    other_kind: kind,
  };
}
