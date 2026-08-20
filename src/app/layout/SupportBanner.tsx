import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LifeBuoy, Loader2 } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useAuth } from '@/app/providers/AuthProvider';

// Barra fixa exibida quando o super admin está operando em uma org de suporte
// (org_id do JWT ≠ home_org_id). O "Voltar" chama /api/admin/switch-org
// { back: true }, atualiza a sessão e recarrega.
export function SupportBanner() {
  const { isSuperAdmin, orgName } = useAppUser();
  const { session } = useAuth();
  const [impersonating, setImpersonating] = useState(false);
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    const meta = (session?.user?.app_metadata ?? {}) as {
      org_id?: string;
      home_org_id?: string;
    };
    setImpersonating(
      isSuperAdmin && !!meta.home_org_id && meta.org_id !== meta.home_org_id,
    );
  }, [isSuperAdmin, session]);

  if (!impersonating) return null;

  const handleBack = async () => {
    setReturning(true);
    try {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getSession();
      const res = await fetch('/api/admin/switch-org', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ back: true }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao voltar.');
      }
      await supabase.auth.refreshSession();
      window.location.href = '/admin';
    } catch (err) {
      setReturning(false);
      toast.error('Falha ao voltar à sua organização', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-2 bg-[rgba(59,130,246,0.12)] border-b border-[rgba(59,130,246,0.25)] text-sm text-[var(--color-text-primary)]">
      <div className="flex items-center gap-2 min-w-0">
        <LifeBuoy className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
        <span className="truncate">
          Você está na organização{' '}
          <strong className="font-semibold">{orgName ?? 'de suporte'}</strong> como suporte.
        </span>
      </div>
      <button
        type="button"
        onClick={() => void handleBack()}
        disabled={returning}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-[rgba(59,130,246,0.35)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)] hover:bg-white/5 disabled:opacity-50"
      >
        {returning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Voltar
      </button>
    </div>
  );
}
