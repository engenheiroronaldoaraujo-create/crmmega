import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  widthClass?: string;
  // Fundo 100% opaco (cor sólida sob o tint do glass-card) — para conteúdo
  // denso (wizards) em que o vazamento do fundo atrapalha a leitura.
  opaque?: boolean;
}

// Minimal modal — no Radix dependency yet. Backdrop click + Escape close.
// Body scroll is locked while open so the glass-card background stays still.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  widthClass = 'max-w-lg',
  opaque = false,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative w-full glass-card p-6 shadow-2xl max-h-[calc(100vh-4rem)] overflow-auto',
          // background-color sólida por baixo do gradiente translúcido do
          // glass-card: nada do fundo vaza, mantendo o tint azul e a borda.
          opaque && 'bg-[#0d101f]',
          widthClass,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          className="absolute top-4 right-4 h-8 w-8 rounded-lg flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/5"
        >
          <X className="h-4 w-4" />
        </button>

        {(title || description) && (
          <header className="mb-5 pr-10">
            {title && (
              <h2 className="text-xl font-bold text-display">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {description}
              </p>
            )}
          </header>
        )}

        {children}
      </div>
    </div>
  );
}
