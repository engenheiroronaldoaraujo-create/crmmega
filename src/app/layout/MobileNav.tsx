import { NavLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

// Drawer de navegação para telas < md (768px). Sem ele, a Sidebar
// (`hidden md:flex`) deixava o app sem NENHUMA navegação no mobile.
export function MobileNav({ open, onClose }: MobileNavProps) {
  const { role, isSuperAdmin } = useAppUser();
  const items = NAV_ITEMS.filter((item) => {
    if (item.superAdminOnly) return isSuperAdmin;
    if (item.adminOnly) return role === 'admin';
    return true;
  });

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 md:hidden transition-opacity duration-300',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside
        className={cn(
          'absolute left-0 top-0 h-full w-72 max-w-[80vw] glass-surface border-r border-[rgba(59,130,246,0.15)] flex flex-col transition-transform duration-300',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        role="dialog"
        aria-label="Navegação"
      >
        <div className="h-16 shrink-0 flex items-center justify-between px-4 border-b border-[rgba(59,130,246,0.1)]">
          <div className="flex items-center gap-2">
            <img
              src="/agentise-mark.png"
              alt="Agentise"
              className="h-9 w-9 rounded-xl"
            />
            <span className="font-semibold text-[var(--color-text-primary)]">Agentise</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar menu"
            className="h-11 w-11 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 min-h-11 text-sm font-medium transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                    isActive
                      ? 'bg-[rgba(59,130,246,0.12)] text-[var(--color-text-primary)] shadow-[0_0_30px_rgba(59,130,246,0.15)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]',
                  )
                }
              >
                <Icon className="h-4.5 w-4.5 shrink-0" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </aside>
    </div>
  );
}
