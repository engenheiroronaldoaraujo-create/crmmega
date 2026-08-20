-- ============================================================================
-- Module 1 · Init: extensions, schema, enums, helpers, grants
-- ============================================================================
-- Extensions live in schema public (Supabase default).
-- Application objects live in schema whatsapp_hub.
-- Encryption key is read from Postgres setting `app.whatsapp_hub_encryption_key`.
-- Set once per database via:
--   ALTER DATABASE postgres SET app.whatsapp_hub_encryption_key = '<32+ char secret>';
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE whatsapp_hub.meta_tier AS ENUM ('tier_250','tier_1k','tier_10k','tier_100k');
CREATE TYPE whatsapp_hub.llm_provider AS ENUM ('openai','claude','gemini');
CREATE TYPE whatsapp_hub.tenant_role AS ENUM ('admin','operator','viewer');
CREATE TYPE whatsapp_hub.template_category AS ENUM ('marketing','utility','service');
CREATE TYPE whatsapp_hub.template_status AS ENUM ('draft','pending','approved','rejected');
CREATE TYPE whatsapp_hub.header_type AS ENUM ('none','text','image','video','document');
CREATE TYPE whatsapp_hub.campaign_status AS ENUM ('draft','scheduled','sending','completed','paused','failed');
CREATE TYPE whatsapp_hub.campaign_contact_status AS ENUM ('pending','sent','delivered','read','replied','failed');
CREATE TYPE whatsapp_hub.follow_up_trigger AS ENUM ('no_reply');
CREATE TYPE whatsapp_hub.conversation_status AS ENUM ('ai_active','human_active','closed');
CREATE TYPE whatsapp_hub.message_direction AS ENUM ('inbound','outbound');
CREATE TYPE whatsapp_hub.sender_type AS ENUM ('contact','ai','operator','system');
CREATE TYPE whatsapp_hub.content_type AS ENUM ('text','image','audio','video','document','template','note');
CREATE TYPE whatsapp_hub.meta_message_status AS ENUM ('sent','delivered','read','failed');
CREATE TYPE whatsapp_hub.knowledge_type AS ENUM ('pdf','doc','url');
CREATE TYPE whatsapp_hub.knowledge_status AS ENUM ('processing','ready','error');
CREATE TYPE whatsapp_hub.notification_type AS ENUM ('new_message','handoff','mention');

-- ----------------------------------------------------------------------------
-- JWT helpers
-- ----------------------------------------------------------------------------

-- Pulls tenant_id from app_metadata in the JWT. Returns NULL when absent
-- (e.g. super_admins without a tenant, or unauthenticated callers).
CREATE OR REPLACE FUNCTION whatsapp_hub.current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    auth.jwt() -> 'app_metadata' ->> 'tenant_id',
    ''
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT auth.jwt() -> 'app_metadata' ->> 'role';
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(whatsapp_hub.current_user_role() = 'super_admin', false);
$$;

-- ----------------------------------------------------------------------------
-- Encryption helpers (pgcrypto, symmetric)
-- ----------------------------------------------------------------------------
-- Stores ciphertext as base64 TEXT for transport friendliness. The key MUST be
-- configured at the database level; a missing key raises rather than silently
-- producing unencrypted output.

CREATE OR REPLACE FUNCTION whatsapp_hub.encrypt_secret(plaintext TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  key TEXT := current_setting('app.whatsapp_hub_encryption_key', true);
BEGIN
  IF plaintext IS NULL THEN
    RETURN NULL;
  END IF;
  IF key IS NULL OR length(key) < 16 THEN
    RAISE EXCEPTION 'app.whatsapp_hub_encryption_key is not configured or too short (need >= 16 chars)';
  END IF;
  RETURN encode(pgp_sym_encrypt(plaintext, key), 'base64');
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.decrypt_secret(ciphertext TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  key TEXT := current_setting('app.whatsapp_hub_encryption_key', true);
BEGIN
  IF ciphertext IS NULL THEN
    RETURN NULL;
  END IF;
  IF key IS NULL OR length(key) < 16 THEN
    RAISE EXCEPTION 'app.whatsapp_hub_encryption_key is not configured or too short (need >= 16 chars)';
  END IF;
  RETURN pgp_sym_decrypt(decode(ciphertext, 'base64'), key);
END;
$$;

-- ----------------------------------------------------------------------------
-- updated_at trigger helper
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- `authenticated` = logged-in Supabase user (RLS applies)
-- `service_role`  = server-side key used by Edge Functions (bypasses RLS)
-- `anon`          = unauthenticated; not granted here because nothing in this
--                   schema is public.

GRANT USAGE ON SCHEMA whatsapp_hub TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_hub
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- Encryption primitives are server-side only
REVOKE EXECUTE ON FUNCTION whatsapp_hub.encrypt_secret(TEXT) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.decrypt_secret(TEXT) FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.encrypt_secret(TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.decrypt_secret(TEXT) TO service_role;
