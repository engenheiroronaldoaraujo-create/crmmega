import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';

// Chaves mínimas para o app operar: WhatsApp (Zernio) + IA (OpenAI).
const REQUIRED_KEYS = ['zernio_api_key', 'openai_api_key'] as const;

type ExistsMap = Record<string, { exists: boolean }>;

// Consulta GET /api/credentials (Bearer de admin) e retorna se alguma das
// chaves obrigatórias está ausente. Só roda para admin — operadores não têm
// permissão nem contexto para configurar credenciais.
export function useMissingCredentials(): { missing: boolean; loading: boolean } {
  const { session } = useAuth();
  const { role } = useAppUser();
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session || role !== 'admin') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const keys = REQUIRED_KEYS.join(',');
    fetch(`/api/credentials?keys=${encodeURIComponent(keys)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => res.json())
      .then((body: ExistsMap) => {
        if (cancelled) return;
        setMissing(REQUIRED_KEYS.some((k) => !body[k]?.exists));
      })
      .catch(() => {
        // Falha silenciosa: o banner é informativo, não bloqueia nada.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, role]);

  return { missing, loading };
}
