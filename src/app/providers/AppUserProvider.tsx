import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from './AuthProvider';

// ----------------------------------------------------------------------------
// AppUserProvider
// ----------------------------------------------------------------------------
// Multi-tenant build: cada usuário pertence a uma organização. O acesso e a
// role vêm do JWT app_metadata (populado pelos triggers de auth). O perfil
// exibível (display_name / avatar_url) vem da linha do próprio user em
// whatsapp_hub.app_users, e os dados da org de whatsapp_hub.organizations.
//
// Role gating deve consumir `useAppUser().role`; o JWT é a fonte de verdade
// para controle de acesso. Se a org estiver arquivada, o app inteiro é
// bloqueado por uma tela cheia (sem sidebar).
// ----------------------------------------------------------------------------

export type AppRole = 'admin' | 'operator';
export type OrgStatus = 'active' | 'archived';

interface AppUserContextValue {
  userId: string | null;
  role: AppRole | null;
  orgId: string | null;
  isSuperAdmin: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  orgName: string | null;
  orgStatus: OrgStatus | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
}

const AppUserContext = createContext<AppUserContextValue | null>(null);

function readRoleFromUser(appMetadata: Record<string, unknown> | undefined): AppRole | null {
  if (!appMetadata) return null;
  const role = appMetadata['role'];
  if (role === 'admin' || role === 'operator') {
    return role;
  }
  return null;
}

function readStringClaim(
  appMetadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = appMetadata?.[key];
  return typeof value === 'string' && value ? value : null;
}

export function AppUserProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  const appMetadata = user?.app_metadata as Record<string, unknown> | undefined;

  const role = useMemo(() => readRoleFromUser(appMetadata), [appMetadata]);
  const orgId = useMemo(() => readStringClaim(appMetadata, 'org_id'), [appMetadata]);
  const isSuperAdmin = useMemo(() => appMetadata?.['is_super_admin'] === true, [appMetadata]);

  // Perfil (display_name / avatar_url) e dados da org são carregados do banco.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgStatus, setOrgStatus] = useState<OrgStatus | null>(null);

  const userId = user?.id ?? null;

  // Carrega a linha do próprio user em app_users (perfil exibível).
  const refreshProfile = useCallback(async () => {
    if (!userId) {
      setDisplayName(null);
      setAvatarUrl(null);
      return;
    }
    const supabase = getSupabase();
    const { data } = await supabase
      .schema('whatsapp_hub')
      .from('app_users')
      .select('display_name, avatar_url')
      .eq('user_id', userId)
      .maybeSingle();
    setDisplayName((data?.display_name as string | null) ?? null);
    setAvatarUrl((data?.avatar_url as string | null) ?? null);
  }, [userId]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  // Dados da própria org (nome + status). Membro pode SELECT a própria org
  // mesmo arquivada; usamos isso para a tela de bloqueio.
  useEffect(() => {
    if (!userId || !orgId) {
      setOrgName(null);
      setOrgStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .schema('whatsapp_hub')
        .from('organizations')
        .select('name, status')
        .eq('id', orgId)
        .maybeSingle();
      if (cancelled) return;
      setOrgName((data?.name as string | null) ?? null);
      setOrgStatus((data?.status as OrgStatus | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, orgId]);

  const value = useMemo<AppUserContextValue>(
    () => ({
      userId,
      role,
      orgId,
      isSuperAdmin,
      displayName,
      avatarUrl,
      orgName,
      orgStatus,
      loading,
      refreshProfile,
    }),
    [userId, role, orgId, isSuperAdmin, displayName, avatarUrl, orgName, orgStatus, loading, refreshProfile],
  );

  return (
    <AppUserContext.Provider value={value}>
      {/* Org desativada bloqueia os membros — mas NUNCA o super admin, que
          precisa do console /admin para reativá-la (evita lockout). */}
      {orgStatus === 'archived' && !isSuperAdmin ? <ArchivedOrgScreen /> : children}
    </AppUserContext.Provider>
  );
}

// Tela cheia de bloqueio quando a org está desativada — sem sidebar, no padrão
// glass do design system.
function ArchivedOrgScreen() {
  const { signOut } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card max-w-md w-full p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(245,158,11,0.12)]">
          <AlertTriangle className="h-6 w-6 text-[#FBBF24]" />
        </div>
        <h1 className="text-xl font-bold text-display text-[var(--color-text-primary)]">
          Organização desativada
        </h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          O acesso a esta organização foi temporariamente suspenso. Entre em
          contato com o administrador do CRM para reativá-la.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="inline-flex items-center justify-center rounded-lg border border-[rgba(59,130,246,0.25)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)] hover:bg-white/5"
        >
          Sair
        </button>
      </div>
    </div>
  );
}

export function useAppUser(): AppUserContextValue {
  const ctx = useContext(AppUserContext);
  if (!ctx) {
    throw new Error('useAppUser must be used inside <AppUserProvider>');
  }
  return ctx;
}
