import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';

export function Sidebar() {
  const { role, isSuperAdmin } = useAppUser();
  // Preferência de recolhimento persiste entre navegações/sessões.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar_collapsed') === '1',
  );
  const toggle = () =>
    setCollapsed((v) => {
      localStorage.setItem('sidebar_collapsed', v ? '0' : '1');
      return !v;
    });

  const items = NAV_ITEMS.filter((item) => {
    if (item.superAdminOnly) return isSuperAdmin;
    if (item.adminOnly) return role === 'admin';
    return true;
  });

  return (
    <aside
      className={cn(
        'hidden md:flex md:flex-col shrink-0 glass-surface border-r border-[rgba(59,130,246,0.1)] will-change-[width] transition-[width] duration-[420ms] ease-[cubic-bezier(0.65,0,0.35,1)]',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Navegação principal"
    >
      <div
        className={cn(
          'h-16 flex items-center border-b border-[rgba(59,130,246,0.08)]',
          collapsed ? 'justify-center px-0' : 'gap-3 px-5',
        )}
      >
        <img
          src="/agentise-mark.png"
          alt="Agentise"
          className="h-9 w-9 shrink-0 rounded-lg shadow-[0_0_20px_rgba(59,130,246,0.35)]"
        />
        {!collapsed && (
          <div className="leading-tight min-w-0 flex-1">
            <div className="text-[0.65rem] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              Agentise
            </div>
            <div className="text-sm font-bold text-[var(--color-text-primary)]">MEGACRM</div>
          </div>
        )}
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-4 space-y-1', collapsed ? 'px-2' : 'px-3')}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center rounded-lg py-2.5 text-sm font-medium transition-all',
                  collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                  'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/5',
                  isActive &&
                    'bg-gradient-to-r from-[rgba(59,130,246,0.18)] to-[rgba(59,130,246,0.04)] text-[var(--color-text-primary)] shadow-[inset_0_1px_0_rgba(59,130,246,0.15)]',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* Seta flutuante fixa no centro VERTICAL DA TELA (fixed), deslizando
          junto com a borda direita da barra (left = largura da sidebar). */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
        title={collapsed ? 'Expandir menu' : 'Recolher menu'}
        className={cn(
          'fixed top-1/2 z-30 hidden h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[rgba(59,130,246,0.3)] bg-[#0F1223] text-[var(--color-text-secondary)] shadow-[0_2px_12px_rgba(0,0,0,0.5)] transition-[left,color,border-color] duration-[420ms] ease-[cubic-bezier(0.65,0,0.35,1)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)] md:flex',
          collapsed ? 'left-16' : 'left-60',
        )}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}
