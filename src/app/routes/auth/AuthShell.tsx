import type { ReactNode } from 'react';

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Shared chrome for /auth/login and /auth/signup — keeps both pages visually
// consistent with /setup without repeating the logo + card + layout code.
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-3">
            <img
              src="/agentise-mark.png"
              alt="Agentise"
              className="h-12 w-12 rounded-xl shadow-[0_0_30px_rgba(59,130,246,0.35)]"
            />
            <div>
              <div className="text-label">Agentise</div>
              <div className="text-xl font-bold text-display">MEGACRM</div>
            </div>
          </div>
        </div>

        <div className="glass-card p-8 space-y-6">
          <header className="space-y-1">
            <h1 className="text-2xl font-bold text-display">{title}</h1>
            {subtitle && (
              <p className="text-sm text-[var(--color-text-secondary)]">{subtitle}</p>
            )}
          </header>

          {children}
        </div>

        {footer && (
          <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
            {footer}
          </p>
        )}
      </div>
    </div>
  );
}
