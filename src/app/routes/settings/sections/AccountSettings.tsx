import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/Avatar';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';

const AVATAR_BUCKET = 'whatsapp-hub-avatars';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function AccountSettings() {
  const { user } = useAuth();
  const { userId, orgId, displayName, avatarUrl, refreshProfile } = useAppUser();
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [updatingEmail, setUpdatingEmail] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);

  // Perfil (nome de exibição + foto). O nome inicial vem do provider; sincroniza
  // quando o perfil recarrega.
  const [name, setName] = useState(displayName ?? '');
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(displayName ?? '');
  }, [displayName]);

  const handleSaveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    setSavingName(true);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('app_users')
      .update({ display_name: name.trim() || null })
      .eq('user_id', userId);
    setSavingName(false);
    if (error) {
      toast.error('Falha ao salvar nome', { description: error.message });
      return;
    }
    await refreshProfile();
    toast.success('Nome de exibição atualizado.');
  };

  const handleAvatarChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite re-selecionar o mesmo arquivo
    if (!file || !userId || !orgId) return;

    const ext = AVATAR_MIME_EXT[file.type];
    if (!ext) {
      toast.error('Formato inválido', { description: 'Envie uma imagem PNG, JPEG ou WEBP.' });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('Imagem muito grande', { description: 'O tamanho máximo é 2MB.' });
      return;
    }

    setUploadingAvatar(true);
    const supabase = getSupabase();
    // Path OBRIGATÓRIO pelas policies do bucket: <org_id>/<user_id>.<ext>
    const path = `${orgId}/${userId}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) {
      setUploadingAvatar(false);
      toast.error('Falha no upload', { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    // Cache-buster: como o path é fixo por user, força o browser a recarregar.
    const publicUrl = `${pub.publicUrl}?t=${Date.now()}`;
    const { error: updErr } = await supabase
      .schema('whatsapp_hub')
      .from('app_users')
      .update({ avatar_url: publicUrl })
      .eq('user_id', userId);
    setUploadingAvatar(false);
    if (updErr) {
      toast.error('Falha ao salvar foto', { description: updErr.message });
      return;
    }
    await refreshProfile();
    toast.success('Foto de perfil atualizada.');
  };

  const handleEmailUpdate = async (e: FormEvent) => {
    e.preventDefault();
    const target = newEmail.trim();
    if (!target) {
      toast.error('Informe o novo e-mail.');
      return;
    }
    if (target === user?.email) {
      toast.error('Esse já é o e-mail atual.');
      return;
    }
    setUpdatingEmail(true);
    const supabase = getSupabase();
    const { error } = await supabase.auth.updateUser({ email: target });
    setUpdatingEmail(false);
    if (error) {
      toast.error('Falha ao alterar e-mail', { description: error.message });
      return;
    }
    toast.success('E-mail atualizado. Pode ser que precise reconfirmar pelo link enviado.');
    setNewEmail('');
  };

  const handlePasswordUpdate = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error('A nova senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('As senhas não coincidem.');
      return;
    }
    setUpdatingPassword(true);
    const supabase = getSupabase();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setUpdatingPassword(false);
    if (error) {
      toast.error('Falha ao alterar senha', { description: error.message });
      return;
    }
    toast.success('Senha atualizada.');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="space-y-5">
      <Card>
        <div className="space-y-4">
          <header>
            <h2 className="text-lg font-bold">Perfil</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Nome e foto exibidos para a equipe na inbox e nas atribuições.
            </p>
          </header>
          <div className="flex items-center gap-4">
            <Avatar src={avatarUrl} name={name || user?.email} size="lg" />
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleAvatarChange}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                disabled={uploadingAvatar}
              >
                {uploadingAvatar ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Trocar foto
                  </>
                )}
              </Button>
              <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                PNG, JPEG ou WEBP · máx 2MB
              </p>
            </div>
          </div>
          <form onSubmit={handleSaveName} className="space-y-2">
            <Label htmlFor="display_name">Nome de exibição</Label>
            <div className="flex gap-2">
              <Input
                id="display_name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como seu nome aparece para a equipe"
                disabled={savingName}
              />
              <Button type="submit" disabled={savingName || name.trim() === (displayName ?? '')}>
                {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <Card>
        <form onSubmit={handleEmailUpdate} className="space-y-4">
          <header>
            <h2 className="text-lg font-bold">E-mail</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Atual:{' '}
              <span className="font-mono text-[var(--color-text-primary)]">
                {user?.email ?? '—'}
              </span>
            </p>
          </header>
          <div className="space-y-2">
            <Label htmlFor="new_email">Novo e-mail</Label>
            <Input
              id="new_email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              disabled={updatingEmail}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={updatingEmail || !newEmail}>
              {updatingEmail ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Atualizar e-mail'
              )}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <form onSubmit={handlePasswordUpdate} className="space-y-4">
          <header>
            <h2 className="text-lg font-bold">Senha</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Mínimo 8 caracteres. A sessão continua ativa após a alteração.
            </p>
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="new_pw">Nova senha</Label>
              <Input
                id="new_pw"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={updatingPassword}
                autoComplete="new-password"
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_pw">Confirmar nova senha</Label>
              <Input
                id="confirm_pw"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={updatingPassword}
                autoComplete="new-password"
                minLength={8}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={updatingPassword || !newPassword || !confirmPassword}>
              {updatingPassword ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Atualizar senha'
              )}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
