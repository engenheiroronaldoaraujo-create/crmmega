import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="top-right"
      richColors
      toastOptions={{
        classNames: {
          toast:
            'glass-card !border-[rgba(59,130,246,0.25)] !bg-[rgba(15,18,35,0.85)] !text-[var(--color-text-primary)]',
          description: '!text-[var(--color-text-secondary)]',
        },
      }}
    />
  );
}
