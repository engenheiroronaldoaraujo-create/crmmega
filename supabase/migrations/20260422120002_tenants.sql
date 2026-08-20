-- ============================================================================
-- Module 1 · Tenants: tenants, tenant_settings, tenant_credentials, tenant_members
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------------

CREATE TABLE whatsapp_hub.tenants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  custom_domain  TEXT UNIQUE,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON whatsapp_hub.tenants
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- tenant_settings (1:1 with tenants)
-- ----------------------------------------------------------------------------

CREATE TABLE whatsapp_hub.tenant_settings (
  tenant_id            UUID PRIMARY KEY REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  logo_url             TEXT,
  favicon_url          TEXT,
  page_title           TEXT,
  primary_color        TEXT,
  secondary_color      TEXT,
  business_hours       JSONB NOT NULL DEFAULT '{}'::jsonb,
  out_of_hours_message TEXT,
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_settings_updated_at
  BEFORE UPDATE ON whatsapp_hub.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- tenant_credentials (1:1, encrypted)
-- ----------------------------------------------------------------------------
-- Meta/LLM secrets are stored encrypted via whatsapp_hub.encrypt_secret().
-- Only service_role (Edge Functions) can decrypt. The frontend never reads
-- these columns directly; RLS below denies non-admin access entirely.

CREATE TABLE whatsapp_hub.tenant_credentials (
  tenant_id                    UUID PRIMARY KEY REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  meta_waba_id                 TEXT,
  meta_business_id             TEXT,
  meta_access_token_encrypted  TEXT,
  meta_phone_number_id         TEXT,
  meta_tier                    whatsapp_hub.meta_tier NOT NULL DEFAULT 'tier_250',
  llm_provider                 whatsapp_hub.llm_provider,
  llm_api_key_encrypted        TEXT,
  openai_api_key_encrypted     TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_credentials_updated_at
  BEFORE UPDATE ON whatsapp_hub.tenant_credentials
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- tenant_members
-- ----------------------------------------------------------------------------

CREATE TABLE whatsapp_hub.tenant_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         whatsapp_hub.tenant_role NOT NULL DEFAULT 'operator',
  is_online    BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  invited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TRIGGER trg_tenant_members_updated_at
  BEFORE UPDATE ON whatsapp_hub.tenant_members
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();
