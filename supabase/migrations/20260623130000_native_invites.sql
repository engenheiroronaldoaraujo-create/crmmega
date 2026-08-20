-- ============================================================================
-- 20260623130000_native_invites
-- ----------------------------------------------------------------------------
-- Módulo 5: convites passam a usar 100% o Supabase Auth nativo
-- (inviteUserByEmail via a Edge Function invite-team-member). Removemos:
--
--   · o caminho de token customizado em handle_new_user (Caso 2 / invite_token);
--   · a tabela whatsapp_hub.invites (token + expiração) — não há mais link
--     próprio nem envio por Resend.
--
-- O convidado entra exclusivamente via `invited_role` em raw_user_meta_data
-- (gravado pelo inviteUserByEmail). O trigger continua: 1º usuário = admin;
-- demais exigem invited_role; caso contrário, self-signup é recusado.
--
-- IMPORTANTE: redefinimos handle_new_user ANTES de dropar `invites`, porque a
-- versão anterior declarava `whatsapp_hub.invites%ROWTYPE` e travaria o DROP.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. handle_new_user sem o caminho de token/tabela invites.
CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_user_count   INT;
  v_invited_role TEXT;
  v_role         whatsapp_hub.tenant_role;
BEGIN
  SELECT COUNT(*) INTO v_user_count FROM whatsapp_hub.app_users;

  -- Caso 0: primeiro usuário vira admin (owner). Sem convite necessário.
  IF v_user_count = 0 THEN
    v_role := 'admin';

  -- Caso 1: convite nativo — invited_role gravado por inviteUserByEmail.
  ELSIF NEW.raw_user_meta_data ? 'invited_role'
        AND (NEW.raw_user_meta_data->>'invited_role') IN ('admin', 'operator') THEN
    v_invited_role := NEW.raw_user_meta_data->>'invited_role';
    v_role := v_invited_role::whatsapp_hub.tenant_role;

  -- Caso 2: sem convite válido — recusar self-signup.
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

-- 2. Remove a tabela de convites customizada (token/expiração/Resend).
DROP TABLE IF EXISTS whatsapp_hub.invites CASCADE;
