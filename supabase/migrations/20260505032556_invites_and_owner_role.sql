-- ============================================================================
-- Sistema de convites — fecha self-signup após o primeiro usuário
-- ----------------------------------------------------------------------------
-- O projeto já trabalha com enum (admin, operator). Semanticamente:
--   · admin    = "owner" (primeiro usuário, único, gerencia convites).
--   · operator = "member" (entra apenas via convite válido).
--
-- Antes desta migration, o trigger handle_new_user permitia self-signup
-- ilimitado (qualquer pessoa que descobrisse a URL podia criar conta como
-- operator). Aqui:
--   · Adicionamos a tabela `invites` (token + expiração 7 dias + email).
--   · Reescrevemos handle_new_user para EXIGIR `invite_token` em
--     raw_user_meta_data quando já existe ≥ 1 usuário.
--   · Mantemos o caminho legado `invited_role` (usado por
--     invite-team-member.ts) operacional para retrocompatibilidade — se a
--     metadata trouxer `invited_role` direto (admin/operator), aceitamos sem
--     consultar `invites`.
--   · O helper `is_owner()` simplifica policies futuras.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Tabela de convites
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  role        whatsapp_hub.tenant_role NOT NULL DEFAULT 'operator',
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invites_token_active_idx
  ON whatsapp_hub.invites(token)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invites_email_idx
  ON whatsapp_hub.invites(lower(email));

-- ----------------------------------------------------------------------------
-- 2. RLS: apenas admin (owner) gerencia convites; service_role acessa tudo.
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invites_admin_all ON whatsapp_hub.invites;
CREATE POLICY invites_admin_all
  ON whatsapp_hub.invites
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- ----------------------------------------------------------------------------
-- 3. Helper: is_owner() — açúcar sintático sobre current_user_role().
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.is_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
  SELECT whatsapp_hub.current_user_role() = 'admin';
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.is_owner() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.is_owner() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. RPC signup_status() — anon pode checar se a instância ainda aceita
--    self-signup (count == 0). Usado pela tela de signup do frontend para
--    decidir entre "abrir cadastro" e "exigir convite".
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.signup_status()
RETURNS TABLE (first_user_pending BOOLEAN, has_owner BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
  SELECT
    (SELECT COUNT(*) FROM whatsapp_hub.app_users) = 0 AS first_user_pending,
    EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE role = 'admin') AS has_owner;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.signup_status() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.signup_status() TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Reescreve handle_new_user — agora:
--    · Caso 0 users: primeiro vira admin (sem token).
--    · Caso ≥ 1 user com `invited_role` direto na metadata: aceita
--      (caminho legado de invite-team-member.ts via Supabase admin invite).
--    · Caso ≥ 1 user com `invite_token` na metadata: valida contra a tabela
--      `invites` (token ativo, não expirado, email bate); marca como usado.
--    · Caso contrário: aborta com mensagem clara.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_user_count   INT;
  v_invited_role TEXT;
  v_token        TEXT;
  v_invite       whatsapp_hub.invites%ROWTYPE;
  v_role         whatsapp_hub.tenant_role;
BEGIN
  SELECT COUNT(*) INTO v_user_count FROM whatsapp_hub.app_users;

  -- Caso 0: primeiro usuário vira admin (owner). Sem token necessário.
  IF v_user_count = 0 THEN
    v_role := 'admin';

  -- Caso 1: caminho legado — invited_role direto (Supabase admin.inviteUserByEmail
  -- ainda funciona via invite-team-member.ts).
  ELSIF NEW.raw_user_meta_data ? 'invited_role'
        AND (NEW.raw_user_meta_data->>'invited_role') IN ('admin', 'operator') THEN
    v_invited_role := NEW.raw_user_meta_data->>'invited_role';
    v_role := v_invited_role::whatsapp_hub.tenant_role;

  -- Caso 2: signup público com token de convite — valida contra invites.
  ELSIF NEW.raw_user_meta_data ? 'invite_token'
        AND (NEW.raw_user_meta_data->>'invite_token') <> '' THEN
    v_token := NEW.raw_user_meta_data->>'invite_token';

    SELECT * INTO v_invite
      FROM whatsapp_hub.invites
     WHERE token = v_token
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
       AND lower(email) = lower(NEW.email);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Convite inválido, expirado, já utilizado ou email não corresponde.'
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE whatsapp_hub.invites
       SET used_at = now()
     WHERE id = v_invite.id;

    v_role := v_invite.role;

  -- Caso 3: nenhum dos canais válidos — recusar.
  ELSE
    RAISE EXCEPTION 'Self-signup desabilitado. Solicite um convite ao owner desta instância.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO whatsapp_hub.app_users (user_id, role, accepted_at)
  VALUES (NEW.id, v_role, now())
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('role', v_role::text)
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.handle_new_user() FROM PUBLIC, authenticated, anon;
