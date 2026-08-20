import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface ZernioNumber {
  display_phone_number: string | null;
  verified_name: string | null;
  messaging_limit_tier: string | null;
  quality_rating: string | null;
  health_status: string | null;
}

interface NumberStatus {
  connected: boolean;
  number: ZernioNumber | null;
}

// Lê o status do número WhatsApp (tier/quality/health) via Edge Function
// zernio-number-status. Usado pelo widget do dashboard.
export function useNumberStatus() {
  const [status, setStatus] = useState<NumberStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.functions.invoke('zernio-number-status', { body: {} });
        if (!cancelled && data?.ok) {
          setStatus({ connected: Boolean(data.connected), number: data.number ?? null });
        }
      } catch {
        // Widget é informativo; falha não bloqueia o dashboard.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loading };
}
