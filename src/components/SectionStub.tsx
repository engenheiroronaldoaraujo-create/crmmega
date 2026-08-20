import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface SectionStubProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

// Generic placeholder used by every not-yet-implemented route during
// foundational modules. Replaced one-by-one as each area lands.
export function SectionStub({ icon: Icon, title, description }: SectionStubProps) {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Icon className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <h1 className="text-2xl font-bold text-display">{title}</h1>
        </div>
      </div>

      <Card>
        <div className="space-y-2">
          <div className="text-label">Em breve</div>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
            {description}
          </p>
        </div>
      </Card>
    </div>
  );
}
