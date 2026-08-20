import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Inbox, MessageSquare, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useNotifications, type NotificationRow } from '@/hooks/useNotifications';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function iconFor(type: NotificationRow['type']) {
  if (type === 'new_message') return MessageSquare;
  if (type === 'handoff') return UserRoundCog;
  return Inbox;
}

export function NotificationsDropdown() {
  const navigate = useNavigate();
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside to close. Listen on mousedown rather than click so a click
  // that starts inside but ends outside (rare) doesn't accidentally close.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const handleItemClick = async (n: NotificationRow) => {
    if (!n.is_read) await markRead(n.id);
    setOpen(false);
    if (n.conversation_id) {
      navigate(`/inbox?conversation=${n.conversation_id}`);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Notificações"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-4.5 w-4.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-[var(--color-error)] text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-[rgba(59,130,246,0.25)] bg-[#0F1223] shadow-2xl z-50 overflow-hidden max-h-[70vh] flex flex-col">
          <div className="flex items-center justify-between p-3 border-b border-[rgba(59,130,246,0.1)]">
            <div>
              <div className="text-label">Notificações</div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                {unreadCount} não lidas · {notifications.length} recentes
              </div>
            </div>
            {unreadCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void markAllRead()}>
                <CheckCheck className="h-3.5 w-3.5" />
                Marcar todas
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="p-8 text-center text-xs text-[var(--color-text-secondary)] opacity-60">
                Sem notificações.
              </div>
            ) : (
              <ul className="divide-y divide-[rgba(59,130,246,0.06)]">
                {notifications.map((n) => {
                  const Icon = iconFor(n.type);
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleItemClick(n)}
                        className={cn(
                          'w-full text-left p-3 flex items-start gap-3 transition-colors',
                          'hover:bg-white/[0.03]',
                          !n.is_read && 'bg-[rgba(59,130,246,0.04)]',
                        )}
                      >
                        <div
                          className={cn(
                            'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                            n.type === 'handoff'
                              ? 'bg-[rgba(245,158,11,0.15)] text-[#FBBF24]'
                              : 'bg-[rgba(59,130,246,0.15)] text-[var(--accent-primary)]',
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                'text-sm font-semibold truncate',
                                n.is_read
                                  ? 'text-[var(--color-text-secondary)]'
                                  : 'text-[var(--color-text-primary)]',
                              )}
                            >
                              {n.title}
                            </div>
                            {!n.is_read && (
                              <span className="h-2 w-2 rounded-full bg-[var(--accent-primary)] shrink-0" />
                            )}
                            <span className="ml-auto text-[10px] text-[var(--color-text-secondary)] shrink-0">
                              {relativeTime(n.created_at)}
                            </span>
                          </div>
                          {n.body && (
                            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">
                              {n.body}
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
