-- ============================================================================
-- Multi-tenancy · Parte 1/3: schema base
-- ----------------------------------------------------------------------------
-- Reintroduz organizações totalmente isoladas (o inverso controlado da
-- 20260430120002_drop_multitenant):
--
--   · whatsapp_hub.organizations — orgs geridas pelo super admin
--     (criar / renomear / arquivar).
--   · whatsapp_hub.channels — números WhatsApp por org (Zernio oficial e
--     UAZAPI), cada um vinculável a um membro (atribuição automática).
--   · public.org_settings — cofre de credenciais POR ORG (substitui o
--     public.app_settings global; mesmo AES-256-GCM via CRYPTO_KEY).
--   · Helpers de JWT: current_org_id() / is_super_admin() / current_org_active()
--     + default_org_id() para integrações single-org legadas.
--   · app_users ganha org_id, display_name, avatar_url, is_super_admin.
--   · handle_new_user passa a exigir convite com org (exceto o 1º usuário da
--     instância, que vira admin + super admin da org padrão).
--
-- O org_id nas ~45 tabelas de domínio + backfill ficam na Parte 2; as policies
-- RLS e funções org-aware na Parte 3.
-- ============================================================================

-- `extensions` no path: pgcrypto (gen_random_bytes) vive no schema extensions
-- no Supabase Cloud.
SET search_path TO whatsapp_hub, public, extensions;

-- ----------------------------------------------------------------------------
-- 1. organizations
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON whatsapp_hub.organizations;
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON whatsapp_hub.organizations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

ALTER TABLE whatsapp_hub.organizations ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.organizations TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Helpers de JWT — as policies dependem só do token (sem lookup recursivo).
--    O trigger handle_new_user espelha org_id / role / is_super_admin em
--    raw_app_meta_data, então auth.jwt()->'app_metadata' é a fonte de verdade.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.current_org_id()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF((auth.jwt()->'app_metadata')->>'org_id', '')::uuid
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(((auth.jwt()->'app_metadata')->>'is_super_admin')::boolean, false)
$$;

-- Org do caller está ativa? Usada em toda policy: org arquivada = acesso zero.
CREATE OR REPLACE FUNCTION whatsapp_hub.current_org_active()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_hub.organizations
     WHERE id = whatsapp_hub.current_org_id() AND status = 'active'
  )
$$;

-- Org "padrão" da instância (a mais antiga ativa). Fallback APENAS para as
-- integrações single-org legadas (landing UTM),
-- que rodam via service role sem contexto de org. Webhooks Zernio/UAZAPI
-- passam org explicitamente — nunca dependem deste fallback.
CREATE OR REPLACE FUNCTION whatsapp_hub.default_org_id()
RETURNS UUID
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT id FROM whatsapp_hub.organizations
   WHERE status = 'active'
   ORDER BY created_at
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION whatsapp_hub.current_org_id()     TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.is_super_admin()     TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.current_org_active() TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.default_org_id()     TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. channels — números WhatsApp por organização.
--    provider='zernio'  → zernio_account_id (a api_key mora em org_settings)
--    provider='uazapi'  → uazapi_server_url + token cifrado (AES-GCM na linha,
--                         mesma CRYPTO_KEY; cifrado/decifrado no backend)
--    webhook_secret     → roteia o webhook UAZAPI (?secret=...) sem depender
--                         do shape do payload
--    assigned_member    → conversas entrantes deste número são atribuídas
--                         automaticamente a este membro (fallback: round-robin)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.channels (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL CHECK (provider IN ('zernio', 'uazapi')),
  label                  TEXT NOT NULL,
  phone                  TEXT,
  zernio_account_id      TEXT,
  uazapi_server_url      TEXT,
  uazapi_token_encrypted TEXT,
  webhook_secret         TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  assigned_member        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channels_zernio_account_unique UNIQUE (org_id, provider, zernio_account_id),
  CONSTRAINT channels_provider_shape CHECK (
    (provider = 'zernio' AND zernio_account_id IS NOT NULL)
    OR
    (provider = 'uazapi' AND uazapi_server_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_channels_org ON whatsapp_hub.channels (org_id);
CREATE INDEX IF NOT EXISTS idx_channels_zernio_account
  ON whatsapp_hub.channels (zernio_account_id) WHERE zernio_account_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_channels_updated_at ON whatsapp_hub.channels;
CREATE TRIGGER trg_channels_updated_at
  BEFORE UPDATE ON whatsapp_hub.channels
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

ALTER TABLE whatsapp_hub.channels ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.channels TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. public.org_settings — cofre de credenciais POR ORG.
--    Mesmo formato do public.app_settings ("iv:tag:cipher", AES-256-GCM com a
--    env CRYPTO_KEY). RLS ligado SEM policies: só a service role lê/escreve
--    (API routes Vercel + Edge Functions). O frontend nunca toca aqui.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_settings (
  org_id          UUID NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);

ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;
-- Sem policies de propósito: inacessível a anon/authenticated.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO service_role;

-- ----------------------------------------------------------------------------
-- 5. app_users: vínculo com a org + perfil do membro + flag de super admin.
--    (org_id ainda NULLABLE aqui; a Parte 2 faz o backfill e trava NOT NULL.)
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.app_users
  ADD COLUMN IF NOT EXISTS org_id         UUID REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS display_name   TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url     TEXT,
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_app_users_org ON whatsapp_hub.app_users (org_id);

-- ----------------------------------------------------------------------------
-- 6. Colunas novas de features (multi-número + foto de perfil de lead).
--    contacts.org_id chega na Parte 2; estas são independentes de org.
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS profile_pic_url        TEXT,
  ADD COLUMN IF NOT EXISTS profile_pic_updated_at TIMESTAMPTZ;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_hub.channels(id) ON DELETE SET NULL;

ALTER TABLE whatsapp_hub.campaigns
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_hub.channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON whatsapp_hub.conversations (channel_id) WHERE channel_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 7. Trigger genérico: preenche org_id a partir da linha-pai quando o INSERT
--    veio sem org (service role / funções legadas). Uso:
--      CREATE TRIGGER ... BEFORE INSERT ... EXECUTE FUNCTION
--        whatsapp_hub._org_from_parent('conversations', 'conversation_id');
--    TG_ARGV[0] = tabela-pai, TG_ARGV[1] = coluna FK na linha nova.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub._org_from_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_parent_id UUID;
BEGIN
  IF NEW.org_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_parent_id := NULLIF(to_jsonb(NEW)->>TG_ARGV[1], '')::uuid;
  IF v_parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT org_id FROM whatsapp_hub.%I WHERE id = $1', TG_ARGV[0])
    INTO NEW.org_id
    USING v_parent_id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub._org_from_parent() FROM PUBLIC, authenticated, anon;

-- ----------------------------------------------------------------------------
-- 8. handle_new_user — signup só via convite com org.
--    · 1º usuário da instância (bootstrap): admin + super admin na org padrão
--      (cria a org se o bootstrap ainda não criou).
--    · Demais: exigem invited_org_id + invited_role no raw_user_meta_data
--      (gravados por inviteUserByEmail / console /admin).
--    Espelha role + org_id + is_super_admin em raw_app_meta_data (JWT).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_user_count INT;
  v_role       whatsapp_hub.tenant_role;
  v_org        UUID;
  v_super      BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_user_count FROM whatsapp_hub.app_users;

  IF v_user_count = 0 THEN
    -- Caso 0: owner da instância (bootstrap). Admin + super admin na org padrão.
    v_role  := 'admin';
    v_super := true;
    SELECT id INTO v_org FROM whatsapp_hub.organizations
     WHERE status = 'active' ORDER BY created_at LIMIT 1;
    IF v_org IS NULL THEN
      INSERT INTO whatsapp_hub.organizations (name, slug)
      VALUES ('Organização Principal', 'principal')
      RETURNING id INTO v_org;
    END IF;

  ELSIF NEW.raw_user_meta_data ? 'invited_role'
        AND (NEW.raw_user_meta_data->>'invited_role') IN ('admin', 'operator')
        AND NULLIF(NEW.raw_user_meta_data->>'invited_org_id', '') IS NOT NULL THEN
    -- Caso 1: convite nativo com org + role.
    v_role := (NEW.raw_user_meta_data->>'invited_role')::whatsapp_hub.tenant_role;
    v_org  := (NEW.raw_user_meta_data->>'invited_org_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.organizations
       WHERE id = v_org AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Organização do convite inexistente ou arquivada.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

  ELSE
    -- Caso 2: sem convite válido — recusar self-signup.
    RAISE EXCEPTION 'Self-signup desabilitado. Solicite um convite ao administrador.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO whatsapp_hub.app_users (user_id, org_id, role, is_super_admin, accepted_at)
  VALUES (NEW.id, v_org, v_role, v_super, now())
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'role',           v_role::text,
                                'org_id',         v_org::text,
                                'home_org_id',    v_org::text,
                                'is_super_admin', v_super
                              )
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.handle_new_user() FROM PUBLIC, authenticated, anon;

-- ----------------------------------------------------------------------------
-- 9. Seed de linhas por-org (settings singleton-por-org). Chamado ao criar
--    org (console /admin, bootstrap) e no backfill da Parte 2.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.seed_org_defaults(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.app_settings (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_settings WHERE org_id = p_org);

  INSERT INTO whatsapp_hub.repurchase_config (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.repurchase_config WHERE org_id = p_org);
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) TO service_role;
