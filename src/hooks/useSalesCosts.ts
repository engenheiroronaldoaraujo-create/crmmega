import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { EMPTY_COSTS, parseCosts, type SalesCosts } from '@/lib/salesCosts';

export { EMPTY_COSTS, hasCosts, netRevenue, parseCosts, parseDecimal } from '@/lib/salesCosts';
export type { SalesCosts } from '@/lib/salesCosts';

// ----------------------------------------------------------------------------
// Custos por venda (faturamento líquido no dashboard).
// Persistidos em whatsapp_hub.app_settings.sales_costs (singleton id=1):
// leitura para todos, escrita admin-only via RLS.
// ----------------------------------------------------------------------------

export function useSalesCosts() {
  const [costs, setCosts] = useState<SalesCosts>(EMPTY_COSTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabase();
    void supabase
      .from('app_settings')
      .select('sales_costs')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setCosts(parseCosts((data as { sales_costs?: unknown }).sales_costs));
        setLoading(false);
      });
  }, []);

  const save = useCallback(async (next: SalesCosts): Promise<string | null> => {
    const clean = parseCosts(next);
    let prev: SalesCosts = EMPTY_COSTS;
    setCosts((cur) => {
      prev = cur;
      return clean;
    });
    const supabase = getSupabase();
    const { error } = await supabase
      .from('app_settings')
      .update({ sales_costs: clean })
      .eq('id', 1);
    // Banco rejeitou (ex.: RLS admin-only): reverte para não exibir um líquido
    // calculado com custos que não foram persistidos.
    if (error) {
      setCosts(prev);
      return error.message;
    }
    return null;
  }, []);

  return { costs, loading, save };
}
