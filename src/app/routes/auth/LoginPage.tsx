import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { AuthShell } from './AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/app/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    const { error } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (error) {
      toast.error('Não foi possível entrar', { description: error });
      return;
    }
    navigate('/dashboard', { replace: true });
  };

  // Esqueci minha senha: dispara o e-mail de recuperação do Supabase. O link
  // aponta para /invite (mesma tela reusa updateUser p/ definir nova senha) no
  // domínio atual (produção na Vercel).
  const handleForgotPassword = async () => {
    const target = email.trim();
    if (!target) {
      toast.error('Informe seu e-mail no campo acima para redefinir a senha.');
      return;
    }
    setResetting(true);
    const supabase = getSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: `${window.location.origin}/invite`,
    });
    setResetting(false);
    if (error) {
      toast.error('Não foi possível enviar o e-mail de redefinição', { description: error.message });
      return;
    }
    toast.success('E-mail de redefinição enviado', {
      description: `Enviamos um link para ${target}. Abra-o para criar uma nova senha.`,
    });
  };

  return (
    <AuthShell
      title="Entrar"
      subtitle="Acesse seu painel MEGACRM."
      footer={
        <>
          Ainda não tem conta?{' '}
          <Link
            to="/auth/signup"
            className="text-[var(--accent-primary)] hover:underline font-medium"
          >
            Criar conta
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
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Senha</Label>
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={resetting || submitting}
              className="text-xs font-medium text-[var(--accent-primary)] hover:underline disabled:opacity-60"
            >
              {resetting ? 'Enviando...' : 'Esqueci minha senha'}
            </button>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={submitting}
          />
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Entrando...
            </>
          ) : (
            <>Entrar</>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
