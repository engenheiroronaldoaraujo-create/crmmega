import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, ShieldOff } from 'lucide-react';
import { AuthShell } from './AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/app/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';

type SignupStatus =
  | { state: 'loading' }
  | { state: 'open' } // primeiro user — vira owner
  | { state: 'closed' } // já tem owner — exige convite
  | { state: 'error'; message: string };

export default function SignupPage() {
  const navigate = useNavigate();
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<SignupStatus>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data, error } = await supabase.rpc('signup_status');
      if (cancelled) return;
      if (error) {
        setStatus({ state: 'error', message: error.message });
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.first_user_pending) {
        setStatus({ state: 'open' });
      } else {
        setStatus({ state: 'closed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    const { error } = await signUp(email.trim(), password);
    setSubmitting(false);

    if (error) {
      toast.error('Não foi possível criar a conta', { description: error });
      return;
    }
    toast.success('Conta criada. Bem-vindo!');
    navigate('/dashboard', { replace: true });
  };

  if (status.state === 'loading') {
    return (
      <AuthShell title="Criar conta" subtitle="Verificando status da instância...">
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" />
        </div>
      </AuthShell>
    );
  }

  if (status.state === 'closed') {
    return (
      <AuthShell
        title="Self-signup desabilitado"
        subtitle="Esta instância já tem um owner. Novos acessos só por convite."
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
          <ShieldOff className="h-12 w-12 text-[var(--color-text-secondary)]" />
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm">
            Solicite um convite ao administrador desta instância. Quando ele
            criar o convite, você receberá um link para finalizar seu cadastro.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (status.state === 'error') {
    return (
      <AuthShell
        title="Erro"
        subtitle="Não consegui consultar o status da instância."
      >
        <p className="text-sm text-[var(--color-error)]">{status.message}</p>
      </AuthShell>
    );
  }

  // status.state === 'open' → primeiro usuário (vira owner).
  return (
    <AuthShell
      title="Criar owner desta instância"
      subtitle="Você é o primeiro usuário — sua conta vira o owner automaticamente."
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
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={submitting}
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
              Criando conta...
            </>
          ) : (
            <>Criar owner</>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
