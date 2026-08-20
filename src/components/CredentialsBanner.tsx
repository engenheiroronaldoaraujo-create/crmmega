import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, X } from 'lucide-react';
import { useMissingCredentials } from '@/hooks/useMissingCredentials';

// Banner discreto (admin-only) avisando que faltam chaves de API para ativar
// WhatsApp e IA. Não bloqueia nada; dispensável na sessão (estado local).
export function CredentialsBanner() {
  const { missing, loading } = useMissingCredentials();
  const [dismissed, setDismissed] = useState(false);

  if (loading || !missing || dismissed) return null;

  return (
    <div className="glass-card flex items-center gap-3 px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(245,158,11,0.15)] text-[#FBBF24]">
        <KeyRound className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 text-sm text-[var(--color-text-primary)]">
        Configure as chaves de API para ativar WhatsApp e IA. A do WhatsApp fica em{' '}
        <Link to="/settings?tab=channels" className="font-semibold text-[var(--accent-primary)] hover:underline">
          Canais
        </Link>{' '}
        e a da OpenAI em{' '}
        <Link to="/ai-agent" className="font-semibold text-[var(--accent-primary)] hover:underline">
          Agente de IA
        </Link>
        .
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dispensar aviso"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
