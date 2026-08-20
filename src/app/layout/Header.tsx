import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Menu, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NotificationsDropdown } from '@/components/NotificationsDropdown';
import { OrgSwitcher } from '@/app/layout/OrgSwitcher';
import { useAuth } from '@/app/providers/AuthProvider';

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  const handleLogout = async () => {
    await signOut();
    toast.success('Sessão encerrada.');
    navigate('/auth/login', { replace: true });
  };

  return (
    <header
      className="h-16 shrink-0 glass-surface border-b border-[rgba(59,130,246,0.08)] flex items-center justify-between px-4 sm:px-6 gap-4"
      role="banner"
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className="md:hidden h-11 w-11 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <OrgSwitcher />

        <NotificationsDropdown />

        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 sm:block text-right leading-tight">
            <div className="text-[0.65rem] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              Conectado
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)] max-w-[140px] lg:max-w-[200px] truncate">
              {user?.email ?? '—'}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sair"
            onClick={handleLogout}
          >
            <LogOut className="h-4.5 w-4.5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
