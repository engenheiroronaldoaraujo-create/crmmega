import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { useSupabaseConfig } from '@/hooks/useSupabase';
import { useAuth } from './providers/AuthProvider';
import { useAppUser } from './providers/AppUserProvider';

// Lazy loading the page chunks keeps the initial bundle lean.
const SetupPage = lazy(() => import('./routes/setup/SetupPage'));
const LoginPage = lazy(() => import('./routes/auth/LoginPage'));
const SignupPage = lazy(() => import('./routes/auth/SignupPage'));
const InvitePage = lazy(() => import('./routes/invite/InvitePage'));
const DashboardPage = lazy(() => import('./routes/dashboard/DashboardPage'));
const InboxPage = lazy(() => import('./routes/inbox/InboxPage'));
const CampaignsPage = lazy(() => import('./routes/campaigns/CampaignsPage'));
const ContactsPage = lazy(() => import('./routes/contacts/ContactsPage'));
const ContactDetailPage = lazy(() => import('./routes/contacts/ContactDetailPage'));
const FunilPage = lazy(() => import('./routes/funil/FunilPage'));
const AIAgentPage = lazy(() => import('./routes/ai-agent/AIAgentPage'));
const AutomationsPage = lazy(() => import('./routes/automations/AutomationsPage'));
const SettingsPage = lazy(() => import('./routes/settings/SettingsPage'));
const AdminPage = lazy(() => import('./routes/admin/AdminPage'));

function PageFallback() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-label opacity-60">Carregando...</div>
    </div>
  );
}

function RequireSetup({ children }: { children: ReactElement }) {
  const { configured } = useSupabaseConfig();
  const location = useLocation();
  if (!configured) {
    return <Navigate to="/setup" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function RequireSession({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageFallback />;
  if (!session) {
    return (
      <Navigate to="/auth/login" state={{ from: location.pathname }} replace />
    );
  }
  return children;
}

// Rotas restritas a admin (Dashboard, Funil): operador é levado para a Inbox.
function AdminOnly({ children }: { children: ReactElement }) {
  const { role, loading } = useAppUser();
  if (loading) return <PageFallback />;
  if (role !== 'admin') {
    return <Navigate to="/inbox" replace />;
  }
  return children;
}

// Console /admin: restrito ao super admin. Demais usuários vão pro dashboard.
function RequireSuperAdmin({ children }: { children: ReactElement }) {
  const { isSuperAdmin, loading } = useAppUser();
  if (loading) return <PageFallback />;
  if (!isSuperAdmin) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

function RedirectIfConfigured({ children }: { children: ReactElement }) {
  const { configured } = useSupabaseConfig();
  const { session } = useAuth();
  const location = useLocation();
  const setupStep = new URLSearchParams(location.search).get('step');
  if (configured) {
    if (location.pathname === '/setup' && setupStep === '4') {
      return children;
    }
    // Already configured → move the user forward. If they also have a
    // session, jump straight to dashboard; otherwise to login.
    return <Navigate to={session ? '/dashboard' : '/auth/login'} replace />;
  }
  return children;
}

function RedirectIfAuthenticated({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  if (loading) return <PageFallback />;
  if (session) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

export function AppRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route
          path="/setup"
          element={
            <RedirectIfConfigured>
              <SetupPage />
            </RedirectIfConfigured>
          }
        />

        <Route
          path="/auth/login"
          element={
            <RequireSetup>
              <RedirectIfAuthenticated>
                <LoginPage />
              </RedirectIfAuthenticated>
            </RequireSetup>
          }
        />
        <Route
          path="/auth/signup"
          element={
            <RequireSetup>
              <RedirectIfAuthenticated>
                <SignupPage />
              </RedirectIfAuthenticated>
            </RequireSetup>
          }
        />
        {/* /invite NÃO usa RedirectIfAuthenticated: o link de convite do
            Supabase estabelece uma sessão, e o convidado precisa dela aberta
            para definir a senha (updateUser) antes de seguir para o app. */}
        <Route
          path="/invite"
          element={
            <RequireSetup>
              <InvitePage />
            </RequireSetup>
          }
        />

        <Route
          element={
            <RequireSetup>
              <RequireSession>
                <AppLayout />
              </RequireSession>
            </RequireSetup>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<AdminOnly><DashboardPage /></AdminOnly>} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          {/* Templates virou aba dentro de Campanhas (Módulo 1) — preserva links salvos. */}
          <Route path="/templates" element={<Navigate to="/campaigns?tab=templates" replace />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactDetailPage />} />
          <Route path="/funil" element={<AdminOnly><FunilPage /></AdminOnly>} />
          {/* /vendas (Vendas & Recompra) removido — redireciona pro dashboard */}
          <Route path="/vendas" element={<Navigate to="/dashboard" replace />} />
          {/* /projetos (Entrega) e /educacao removidos — redirecionam pro funil */}
          <Route path="/projetos" element={<Navigate to="/funil" replace />} />
          <Route path="/educacao" element={<Navigate to="/funil" replace />} />
          <Route path="/ai-agent" element={<AIAgentPage />} />
          <Route path="/automations" element={<AdminOnly><AutomationsPage /></AdminOnly>} />
          {/* Rotas antigas → agora abas dentro de /ai-agent */}
          <Route path="/knowledge" element={<Navigate to="/ai-agent" replace />} />
          <Route path="/follow-ups" element={<Navigate to="/automations?tab=followups" replace />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings/profile" element={<SettingsPage />} />
          <Route path="/admin" element={<RequireSuperAdmin><AdminPage /></RequireSuperAdmin>} />
          {/* Credenciais agora é aba dentro de Configurações */}
          <Route path="/settings/credentials" element={<Navigate to="/settings/profile" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
