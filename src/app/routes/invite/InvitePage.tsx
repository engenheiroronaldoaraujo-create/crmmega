import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, MailCheck, ShieldAlert } from 'lucide-react';
import { AuthShell } from '../auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/app/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';

// ----------------------------------------------------------------------------
// Invite — aceite de convite nativo do Supabase.
// ----------------------------------------------------------------------------
// O owner convida via `invite-team-member` → o Supabase envia o e-mail de
// convite (inviteUserByEmail). O link do e-mail aponta para esta tela com a
// sessão já estabelecida (detectSessionInUrl). O usuário convidado apenas
// define a senha (updateUser) — o app_user com o role correto já foi criado
// pelo trigger handle_new_user no momento do convite (via invited_role).
//
// Sem token/tabela `invites` e sem Resend: o convite é 100% Supabase Auth.
// ----------------------------------------------------------------------------

export default function InvitePage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      toast.error('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      toast.error('As senhas não coincidem.');
      return;
    }

    setSubmitting(true);
    const supabase = getSupabase();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSubmitting(false);
      toast.error('Não foi possível definir a senha', { description: error.message });
      return;
    }
    // Garante que o JWT em uso já carrega o claim de role gravado pelo trigger.
    await supabase.auth.refreshSession();
    setSubmitting(false);
    toast.success('Conta ativada. Bem-vindo!');
    navigate('/dashboard', { replace: true });
  };

  if (loading) {
    return (
      <AuthShell title="Aceitar convite" subtitle="Validando seu convite...">
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" />
        </div>
      </AuthShell>
    );
  }

  // Sem sessão = o link não foi aberto a partir do e-mail de convite, ou já
  // expirou / foi consumido.
  if (!session) {
    return (
      <AuthShell
        title="Convite inválido"
        subtitle="O link parece estar incorreto ou expirado."
        footer={
          <>
            Já tem conta?{' '}
            <Link
              to="/auth/login"
              className="text-[var(--accent-primary)] hover:underline font-medium"
            >
              Entrar
            </Link>
          </>
        }
      >
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <ShieldAlert className="h-12 w-12 text-[var(--color-error)]" />
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm">
            Abra o link diretamente do e-mail de convite. Se já passou da validade,
            peça um novo convite ao owner desta instância.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Aceitar convite"
      subtitle="Defina sua senha para acessar a instância."
      footer={
        <>
          Já tem conta?{' '}
          <Link
            to="/auth/login"
            className="text-[var(--accent-primary)] hover:underline font-medium"
          >
            Entrar
          </Link>
        </>
      }
    >
      <div className="flex justify-center mb-2">
        <MailCheck className="h-10 w-10 text-[var(--accent-primary)]" />
      </div>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="invite-email">E-mail</Label>
          <Input
            id="invite-email"
            type="email"
            value={session.user.email ?? ''}
            readOnly
            disabled
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Senha</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={submitting}
            minLength={8}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirmar senha</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            disabled={submitting}
            minLength={8}
          />
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Ativando...
            </>
          ) : (
            <>Definir senha e entrar</>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
