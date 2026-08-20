import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Gradiente 135° #1E3A8A→#3B82F6 (botão primário do DS Agentise) com
        // glow azul no hover (30→48px). Antes era cor chapada, fora do DS.
        default:
          'bg-[linear-gradient(135deg,#1E3A8A,#3B82F6)] text-white shadow-[0_0_30px_rgba(59,130,246,0.25)] hover:shadow-[0_0_48px_rgba(59,130,246,0.5)] hover:brightness-110',
        secondary:
          'bg-white/5 text-[var(--color-text-primary)] border border-[rgba(59,130,246,0.2)] hover:bg-white/10 hover:border-[rgba(59,130,246,0.4)]',
        ghost:
          'text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]',
        outline:
          'border border-[rgba(59,130,246,0.25)] bg-transparent text-[var(--color-text-primary)] hover:bg-white/5 hover:border-[rgba(59,130,246,0.5)]',
        destructive:
          'bg-[var(--color-error)] text-white hover:bg-[var(--color-error)]/90',
        link:
          'text-[var(--accent-primary)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-12 rounded-lg px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
