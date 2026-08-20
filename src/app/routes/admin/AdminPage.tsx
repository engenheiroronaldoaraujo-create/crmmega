import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Building2, Loader2, Plus, LogIn, Pencil, Ban, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';

// Console do SUPER ADMIN (/admin). Lista as organizações da instância, permite
// criar, renomear, desativar/reativar e "entrar como suporte" (troca o org_id
// do JWT via /api/admin/switch-org). Uma org desativada continua na lista, mas
// seus membros são bloqueados por uma tela de aviso. O guard RequireSuperAdmin
// fica no router. (O status persiste como 'archived' no banco — "desativada" é
// só o rótulo na UI; toda a lógica de RLS/cron/webhook já filtra por 'active'.)

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  created_at: string;
  members: number;
}

// Gera um slug base a partir do nome (para o campo auto-preenchido, editável).
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? ''}`,
  };
}

export default function AdminPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OrgRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/orgs', { headers: await authHeaders() });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao carregar organizações.');
      }
      setOrgs(body.orgs as OrgRow[]);
    } catch (err) {
      toast.error('Não foi possível carregar as organizações', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handlePatch = async (
    id: string,
    payload: { name?: string; slug?: string; status?: 'active' | 'archived' },
  ) => {
    setBusyId(id);
    try {
      const res = await fetch('/api/admin/orgs', {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({ id, ...payload }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao atualizar.');
      }
      toast.success('Organização atualizada.');
      await load();
      return true;
    } catch (err) {
      toast.error('Falha ao atualizar', {
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleStatusToggle = async (org: OrgRow) => {
    const next = org.status === 'active' ? 'archived' : 'active';
    const message =
      next === 'archived'
        ? `Desativar a organização "${org.name}"? Os membros perderão o acesso e verão um aviso para contatar o administrador até a reativação.`
        : `Reativar a organização "${org.name}"? Os membros voltarão a ter acesso.`;
    if (!window.confirm(message)) return;
    await handlePatch(org.id, { status: next });
  };

  const handleEnterAsSupport = async (org: OrgRow) => {
    if (!window.confirm(`Entrar como suporte em "${org.name}"? Você passará a operar nessa organização.`)) {
      return;
    }
    setBusyId(org.id);
    try {
      const res = await fetch('/api/admin/switch-org', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ orgId: org.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao entrar na organização.');
      }
      await getSupabase().auth.refreshSession();
      window.location.href = '/dashboard';
    } catch (err) {
      setBusyId(null);
      toast.error('Falha ao entrar como suporte', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-display flex items-center gap-2">
            <Building2 className="h-6 w-6 text-[var(--accent-primary)]" /> Organizações
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Gerencie todas as organizações desta instância. Entre como suporte para operar em nome de uma delas.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> Nova organização
        </Button>
      </div>

      <Card>
        {loading ? (
          <div className="text-sm text-[var(--color-text-secondary)] opacity-60 py-6 text-center">
            Carregando...
          </div>
        ) : orgs.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)] opacity-60 py-6 text-center">
            Nenhuma organização ainda.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-label border-b border-[rgba(59,130,246,0.12)]">
                  <th className="text-left font-semibold pb-3 pr-4">Organização</th>
                  <th className="text-left font-semibold pb-3 pr-4">Slug</th>
                  <th className="text-left font-semibold pb-3 pr-4">Status</th>
                  <th className="text-left font-semibold pb-3 pr-4">Membros</th>
                  <th className="text-left font-semibold pb-3 pr-4">Criada em</th>
                  <th className="text-right font-semibold pb-3">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(59,130,246,0.08)]">
                {orgs.map((org) => (
                  <tr key={org.id} className="text-[var(--color-text-primary)]">
                    <td className="py-3 pr-4 font-medium">{org.name}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-[var(--color-text-secondary)]">
                      {org.slug}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge status={org.status} />
                    </td>
                    <td className="py-3 pr-4 text-[var(--color-text-secondary)]">{org.members}</td>
                    <td className="py-3 pr-4 text-[var(--color-text-secondary)]">
                      {new Date(org.created_at).toLocaleDateString('pt-BR')}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconAction
                          label="Renomear"
                          onClick={() => setEditing(org)}
                          disabled={busyId === org.id}
                          icon={<Pencil className="h-4 w-4" />}
                        />
                        <IconAction
                          label={org.status === 'active' ? 'Desativar' : 'Reativar'}
                          onClick={() => void handleStatusToggle(org)}
                          disabled={busyId === org.id}
                          icon={
                            org.status === 'active' ? (
                              <Ban className="h-4 w-4" />
                            ) : (
                              <RotateCcw className="h-4 w-4" />
                            )
                          }
                        />
                        <IconAction
                          label="Entrar como suporte"
                          onClick={() => void handleEnterAsSupport(org)}
                          disabled={busyId === org.id || org.status === 'archived'}
                          icon={
                            busyId === org.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <LogIn className="h-4 w-4" />
                            )
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen && (
        <CreateOrgDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await load();
          }}
        />
      )}

      {editing && (
        <RenameOrgDialog
          org={editing}
          onClose={() => setEditing(null)}
          onSaved={async (name, slug) => {
            const ok = await handlePatch(editing.id, { name, slug });
            if (ok) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'archived' }) {
  const active = status === 'active';
  return (
    <span
      className={
        active
          ? 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-[rgba(16,185,129,0.12)] text-[#10B981]'
          : 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-white/5 text-[var(--color-text-secondary)]'
      }
    >
      {active ? 'Ativa' : 'Desativada'}
    </span>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {icon}
    </button>
  );
}

function CreateOrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const effectiveSlug = useMemo(
    () => (slugTouched ? slug : slugify(name)),
    [slug, slugTouched, name],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Informe o nome da organização.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/orgs', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          name: name.trim(),
          slug: effectiveSlug,
          adminEmail: adminEmail.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        throw new Error(body.message ?? 'Falha ao criar organização.');
      }
      if (body.warning) {
        toast.warning(body.warning);
      } else {
        toast.success('Organização criada.');
      }
      await onCreated();
    } catch (err) {
      toast.error('Falha ao criar organização', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Nova organização" opaque>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org_name">Nome</Label>
          <Input
            id="org_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Empresa Exemplo"
            disabled={saving}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_slug">Slug</Label>
          <Input
            id="org_slug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="empresa-exemplo"
            disabled={saving}
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            2 a 40 caracteres: letras minúsculas, números e hífen.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_admin">E-mail do admin inicial (opcional)</Label>
          <Input
            id="org_admin"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="admin@empresa.com"
            disabled={saving}
          />
          <p className="text-xs text-[var(--color-text-secondary)]">
            Recebe um convite para definir a senha e administrar a organização.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Criando...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" /> Criar
              </>
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameOrgDialog({
  org,
  onClose,
  onSaved,
}: {
  org: OrgRow;
  onClose: () => void;
  onSaved: (name: string, slug: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Informe o nome da organização.');
      return;
    }
    setSaving(true);
    await onSaved(name.trim(), slug.trim());
    setSaving(false);
  };

  return (
    <Dialog open onClose={onClose} title="Renomear organização" opaque>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rename_name">Nome</Label>
          <Input
            id="rename_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rename_slug">Slug</Label>
          <Input
            id="rename_slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Salvando...
              </>
            ) : (
              'Salvar'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
