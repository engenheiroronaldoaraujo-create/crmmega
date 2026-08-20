import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { GripVertical, Loader2, Mail, Plus, Shuffle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/Avatar';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useLeadAssignmentQueue } from '@/hooks/useLeadAssignmentQueue';

type Role = 'admin' | 'operator';

// supabase.functions.invoke zera `data` em respostas não-2xx (o erro vira
// FunctionsHttpError com o Response em `.context`). Lê o corpo pra mostrar a
// mensagem amigável da função (ex.: "Já existe um usuário com esse e-mail")
// em vez do genérico "Edge Function returned a non-2xx status code".
async function invokeErrorMessage(error: unknown, data: { error?: string } | null): Promise<string> {
  if (data?.error) return data.error;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* corpo não-JSON */
    }
  }
  return (error as { message?: string } | null)?.message ?? 'Erro desconhecido';
}

interface MemberRow {
  id: string;
  role: Role;
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  accepted_at: string | null;
}

export function TeamSettings() {
  const { userId, role: callerRole } = useAppUser();
  const isOwner = callerRole === 'admin';

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadAll = async () => {
    if (!userId) return;
    const supabase = getSupabase();

    // app_users guarda role/perfil; o e-mail vem da RPC list_operators (join
    // com auth.users, SECURITY DEFINER). display_name/avatar_url também chegam
    // pela RPC (fonte única já filtrada pela org). Merge por user_id.
    const [membersRes, opsRes] = await Promise.all([
      supabase
        .from('app_users')
        .select('id, role, user_id, accepted_at')
        .order('invited_at', { ascending: true }),
      supabase.schema('whatsapp_hub').rpc('list_operators'),
    ]);

    if (membersRes.error) {
      toast.error('Não foi possível carregar a equipe', {
        description: membersRes.error.message,
      });
    } else {
      const opByUser = new Map<string, { email: string; display_name: string | null; avatar_url: string | null }>(
        ((opsRes.data ?? []) as Array<{ user_id: string; email: string; display_name: string | null; avatar_url: string | null }>).map(
          (o) => [o.user_id, { email: o.email, display_name: o.display_name, avatar_url: o.avatar_url }],
        ),
      );
      setMembers(
        (membersRes.data ?? []).map((row) => {
          const op = opByUser.get(row.user_id as string);
          return {
            id: row.id as string,
            role: row.role as Role,
            user_id: row.user_id as string,
            email: op?.email ?? null,
            display_name: op?.display_name ?? null,
            avatar_url: op?.avatar_url ?? null,
            accepted_at: (row.accepted_at as string | null) ?? null,
          };
        }),
      );
    }

    setLoading(false);
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isOwner]);

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error('Informe um e-mail.');
      return;
    }

    setInviting(true);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('invite-team-member', {
      // app_url = domínio atual (produção na Vercel) para o link do e-mail não
      // cair em localhost.
      body: { email: email.trim(), role, app_url: window.location.origin },
    });
    setInviting(false);

    if (error || !data?.ok) {
      toast.error('Falha ao enviar convite', {
        description: await invokeErrorMessage(error, data),
      });
      return;
    }

    toast.success(`Convite enviado para ${email.trim()}`, {
      description: 'O Supabase enviou o e-mail; o convidado define a senha pelo link.',
    });

    setEmail('');
    void loadAll();
  };

  const handleRemove = async (member: MemberRow) => {
    const label = member.email ?? member.user_id;
    if (!window.confirm(`Remover ${label} da equipe? Esta ação é irreversível.`)) return;

    setRemovingId(member.user_id);
    const supabase = getSupabase();
    const { data, error } = await supabase.functions.invoke('delete-team-member', {
      body: { user_id: member.user_id },
    });
    setRemovingId(null);

    if (error || !data?.ok) {
      toast.error('Falha ao remover membro', {
        description: await invokeErrorMessage(error, data),
      });
      return;
    }

    toast.success(`${label} removido da equipe.`);
    void loadAll();
  };

  return (
    <div className="space-y-6">
    <Card>
      <div className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Equipe</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {isOwner
              ? 'Convide novos membros por e-mail. O Supabase envia o convite e o membro define a senha pelo link.'
              : 'Apenas o owner desta instância pode convidar membros.'}
          </p>
        </header>

        {isOwner && (
          <form
            onSubmit={handleInvite}
            className="grid grid-cols-1 md:grid-cols-[1fr_160px_auto] gap-3 items-end"
          >
            <div className="space-y-2">
              <Label htmlFor="invite_email">E-mail</Label>
              <Input
                id="invite_email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operador@suaempresa.com"
                disabled={inviting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite_role">Role</Label>
              <select
                id="invite_role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={inviting}
                className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
              >
                <option value="admin">Admin</option>
                <option value="operator">Operador</option>
              </select>
            </div>
            <Button type="submit" disabled={inviting}>
              {inviting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Enviando...
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4" />
                  Convidar
                </>
              )}
            </Button>
          </form>
        )}

        <div className="space-y-2">
          <div className="text-label">Membros atuais</div>
          {loading ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-60">
              Carregando...
            </div>
          ) : members.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-60">
              Nenhum membro ainda.
            </div>
          ) : (
            <ul className="divide-y divide-[rgba(59,130,246,0.08)] rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02]">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between p-3 gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar src={m.avatar_url} name={m.display_name ?? m.email} size="sm" />
                    <div className="text-sm min-w-0">
                      <div className="text-[var(--color-text-primary)] truncate max-w-[280px]">
                        {m.display_name?.trim() || m.email || m.user_id}
                      </div>
                      <div className="text-[var(--color-text-secondary)] text-xs truncate max-w-[280px]">
                        {m.display_name?.trim() && m.email ? `${m.email} · ` : ''}
                        {m.accepted_at
                          ? `Aceitou em ${new Date(m.accepted_at).toLocaleDateString('pt-BR')}`
                          : 'Convite pendente'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs uppercase tracking-wide font-semibold text-[var(--accent-primary)]">
                      {m.role === 'admin' ? 'Owner' : 'Operador'}
                    </span>
                    {isOwner && m.user_id !== userId && (
                      <button
                        type="button"
                        onClick={() => void handleRemove(m)}
                        disabled={removingId === m.user_id}
                        aria-label={`Remover ${m.email ?? m.user_id}`}
                        title="Remover membro"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[rgba(239,68,68,0.12)] hover:text-[#EF4444] disabled:opacity-50"
                      >
                        {removingId === m.user_id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>

      {isOwner && <LeadQueueManager />}
    </div>
  );
}

// Distribuição automática (round-robin) de leads no handoff: toggle global +
// fila reordenável por drag. Admin-only (a RLS também bloqueia escrita de não-admin).
function LeadQueueManager() {
  const { enabled, queue, available, loading, toggle, add, remove, reorder } = useLeadAssignmentQueue();
  const [addChoice, setAddChoice] = useState('');
  const dragIdx = useRef<number | null>(null);
  // Total geral de conversas atribuídas a cada membro da fila (todas as
  // origens: rodízio, número vinculado ou atribuição manual).
  const [convCounts, setConvCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (queue.length === 0) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const entries = await Promise.all(
        queue.map(async (m) => {
          const { count } = await supabase
            .schema('whatsapp_hub')
            .from('conversations')
            .select('id', { count: 'exact', head: true })
            .eq('assigned_to', m.user_id);
          return [m.user_id, count ?? 0] as const;
        }),
      );
      if (!cancelled) setConvCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [queue]);

  const onDrop = (targetIdx: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === targetIdx) return;
    const ids = queue.map((q) => q.user_id);
    const [moved] = ids.splice(from, 1);
    ids.splice(targetIdx, 0, moved);
    void reorder(ids);
  };

  const wrap = (fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Card>
      <div className="space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-display flex items-center gap-2">
              <Shuffle className="h-5 w-5 text-[var(--accent-primary)]" /> Distribuição automática de leads
            </h2>
            <div className="space-y-1.5 text-sm text-[var(--color-text-secondary)]">
              <p>Como um lead ganha responsável, nesta ordem:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  <span className="text-[var(--color-text-label)]">Número com operador vinculado</span>{' '}
                  (em Configurações → Canais): a conversa que chega por aquele número já nasce
                  atribuída ao operador — não passa pelo rodízio.
                </li>
                <li>
                  <span className="text-[var(--color-text-label)]">Rodízio no handoff</span>: quando a
                  IA é pausada e a conversa está sem responsável, o lead vai para o próximo da fila
                  abaixo que estiver <span className="text-[var(--color-text-label)]">online</span>{' '}
                  (quem está offline é pulado).
                </li>
              </ol>
              <p>
                Atribuições manuais nunca são sobrescritas. Com a fila vazia ou ninguém online, o
                lead fica sem responsável e toda a equipe é notificada do handoff.
              </p>
            </div>
          </div>
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.25)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={wrap(() => toggle(!enabled))}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
            {enabled ? 'Ativada' : 'Desativada'}
          </label>
        </header>

        <div className="space-y-2">
          <div className="text-label">Fila de rodízio</div>
          {loading ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-60">Carregando...</div>
          ) : queue.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)] opacity-70">
              Fila vazia — enquanto assim, o handoff continua notificando toda a equipe.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {queue.map((m, i) => (
                <li
                  key={m.user_id}
                  draggable
                  onDragStart={() => { dragIdx.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(59,130,246,0.15)] bg-white/[0.02] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-[var(--color-text-secondary)]" />
                    <span className="text-xs font-mono text-[var(--color-text-secondary)]">{i + 1}.</span>
                    <span className="truncate text-sm text-[var(--color-text-primary)]">{m.email}</span>
                  </div>
                  <span
                    className="ml-auto shrink-0 rounded-full bg-[rgba(59,130,246,0.1)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--accent-secondary)]"
                    title="Total geral de conversas atribuídas a este membro (rodízio, número vinculado ou manual)"
                  >
                    {convCounts[m.user_id] ?? '…'} conversas
                  </span>
                  <button
                    type="button"
                    onClick={wrap(() => remove(m.user_id))}
                    aria-label={`Remover ${m.email} da fila`}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[rgba(239,68,68,0.12)] hover:text-[#EF4444]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {available.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="queue_add">Adicionar à fila</Label>
              <select
                id="queue_add"
                value={addChoice}
                onChange={(e) => setAddChoice(e.target.value)}
                className="h-11 w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 text-sm text-[var(--color-text-primary)]"
              >
                <option value="">Selecione um membro…</option>
                {available.map((o) => (
                  <option key={o.user_id} value={o.user_id}>{o.email}</option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              disabled={!addChoice}
              onClick={wrap(async () => { await add(addChoice); setAddChoice(''); })}
            >
              <Plus className="h-4 w-4" /> Adicionar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
