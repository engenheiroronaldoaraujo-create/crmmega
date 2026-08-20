import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'flex h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-2 text-sm',
          'placeholder:text-[var(--color-text-secondary)] placeholder:opacity-60',
          'text-[var(--color-text-primary)]',
          'transition-colors',
          'focus:border-[var(--accent-primary)] focus:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/20',
          'disabled:cursor-not-allowed disabled:opacity-40',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
