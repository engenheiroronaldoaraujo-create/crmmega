import { AlertTriangle, RotateCw } from 'lucide-react';

interface LoadErrorBannerProps {
  /** Mensagem técnica do erro (opcional — exibida como detalhe). */
  message?: string | null;
  /** Callback de nova tentativa. */
  onRetry?: () => void;
}

// Banner padrão para FALHA DE CARREGAMENTO de uma lista/tela. Sem ele, uma
// query que falha (rede, RLS, PostgREST) caía num estado vazio enganoso
// ("Nenhum registro ainda") sem indicar erro nem oferecer retry — um
// dead-end clássico para o usuário leigo.
export function LoadErrorBanner({ message, onRetry }: LoadErrorBannerProps) {
  return (
    <div className="glass-card p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-[rgba(239,68,68,0.3)]">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--color-error)]" />
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">
            Não foi possível carregar os dados.
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            Verifique sua conexão e tente novamente.
            {message ? ` Detalhe: ${message}` : ''}
          </p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[rgba(59,130,246,0.25)] bg-white/[0.03] px-4 text-sm font-medium text-[var(--color-text-primary)] transition-all duration-[0.4s] [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] hover:border-[#3B82F6] hover:shadow-[0_0_30px_rgba(59,130,246,0.25)]"
        >
          <RotateCw className="h-4 w-4" />
          Tentar novamente
        </button>
      )}
    </div>
  );
}
