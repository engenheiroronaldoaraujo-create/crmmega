import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { Product, ProductType } from '@/types/crm';

// CRUD do catálogo de produtos (Configurações → Produtos). Os produtos podem
// ser atribuídos a leads/negócios via deal_products (DealDrawer).

interface ProductInput {
  name: string;
  product_type: ProductType;
  quantity: number | null; // estoque opcional (qualquer tipo)
  description?: string | null;
}

interface UseProductsResult {
  products: Product[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: ProductInput) => Promise<Product | null>;
  update: (id: string, patch: Partial<ProductInput>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

// Quantidade agora é opcional para qualquer tipo (classes personalizadas
// como imóveis podem ter estoque) — só sanitiza negativos.
function normalize<T extends Partial<ProductInput>>(input: T): T {
  if (input.quantity != null && input.quantity < 0) {
    return { ...input, quantity: null };
  }
  return input;
}

export function useProducts(): UseProductsResult {
  const { userId } = useAppUser();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('products')
      .select('id, name, product_type, quantity, description')
      .order('name', { ascending: true });
    if (err) setError(err.message);
    else setProducts((data ?? []) as Product[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create: UseProductsResult['create'] = async (input) => {
    if (!userId) return null;
    const supabase = getSupabase();
    const payload = normalize({ ...input, name: input.name.trim() });
    const { data, error: err } = await supabase
      .from('products')
      .insert(payload)
      .select('id, name, product_type, quantity, description')
      .single();
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
    return data as Product;
  };

  const update: UseProductsResult['update'] = async (id, patch) => {
    const supabase = getSupabase();
    const { error: err } = await supabase
      .from('products')
      .update(normalize(patch))
      .eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  const remove: UseProductsResult['remove'] = async (id) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.from('products').delete().eq('id', id);
    if (err) {
      setError(err.message);
      throw new Error(translateDbError(err.message));
    }
    await reload();
  };

  return { products, loading, error, reload, create, update, remove };
}

// Maps the most common Postgres/PostgREST errors to actionable pt-BR messages.
function translateDbError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('duplicate key')) return 'Já existe um produto com esse nome.';
  if (lower.includes('row-level security') || lower.includes('permission denied')) return 'Você não tem permissão para esta ação.';
  if (lower.includes('violates foreign key')) return 'Não é possível excluir: o produto está vinculado a negócios.';
  if (lower.includes('violates check constraint') || lower.includes('invalid input')) return 'Dados inválidos — revise os campos e tente novamente.';
  return message || 'Não foi possível concluir a operação.';
}
