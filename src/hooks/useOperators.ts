import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface Operator {
  user_id: string;
  email: string;
  role: 'admin' | 'operator';
  display_name: string | null;
  avatar_url: string | null;
}

// Nome exibível de um operador: display_name do perfil, senão a parte local do
// e-mail. Usado em badges de atribuição, seletores e listas de equipe.
export function operatorLabel(op: Pick<Operator, 'display_name' | 'email'> | undefined | null): string {
  if (!op) return '';
  return op.display_name?.trim() || op.email.split('@')[0];
}

// Lista os membros da instância (via RPC list_operators) para o seletor de
// atribuição de conversas.
export function useOperators() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.schema('whatsapp_hub').rpc('list_operators');
      if (!cancelled) {
        setOperators((data ?? []) as Operator[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { operators, loading };
}
