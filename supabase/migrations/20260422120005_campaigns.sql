-- ============================================================================
-- Module 1 · Campaigns, Campaign Contacts, Follow-up Rules
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- campaigns
-- ----------------------------------------------------------------------------
-- Counters (sent/delivered/read/replied/failed) are incremented by the webhook
-- handler or dispatch worker; total_contacts is set once when the queue is
-- materialized. Keeping them on the row avoids aggregating on every dashboard
-- render.

CREATE TABLE whatsapp_hub.campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  template_id       UUID NOT NULL REFERENCES whatsapp_hub.templates(id) ON DELETE RESTRICT,
  status            whatsapp_hub.campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at      TIMESTAMPTZ,
  audience_filter   JSONB NOT NULL DEFAULT '{}'::jsonb,
  variable_mapping  JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_contacts    INT NOT NULL DEFAULT 0,
  sent              INT NOT NULL DEFAULT 0,
  delivered         INT NOT NULL DEFAULT 0,
  read              INT NOT NULL DEFAULT 0,
  replied           INT NOT NULL DEFAULT 0,
  failed            INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON whatsapp_hub.campaigns
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- campaign_contacts (dispatch queue)
-- ----------------------------------------------------------------------------
-- One row per (campaign, contact). Holds per-recipient delivery state and is
-- the primary table the dispatch cron scans for pending work.

CREATE TABLE whatsapp_hub.campaign_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES whatsapp_hub.campaigns(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  status           whatsapp_hub.campaign_contact_status NOT NULL DEFAULT 'pending',
  error_message    TEXT,
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  read_at          TIMESTAMPTZ,
  replied_at       TIMESTAMPTZ,
  meta_message_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_campaign_contacts_updated_at
  BEFORE UPDATE ON whatsapp_hub.campaign_contacts
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- follow_up_rules
-- ----------------------------------------------------------------------------
-- campaign_id nullable: a rule without a campaign is tenant-wide (applies to
-- every campaign). sequence_order chains multiple follow-ups (1=24h, 2=48h...).

CREATE TABLE whatsapp_hub.follow_up_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  campaign_id        UUID REFERENCES whatsapp_hub.campaigns(id) ON DELETE CASCADE,
  trigger_condition  whatsapp_hub.follow_up_trigger NOT NULL DEFAULT 'no_reply',
  delay_hours        INT NOT NULL CHECK (delay_hours > 0),
  template_id        UUID NOT NULL REFERENCES whatsapp_hub.templates(id) ON DELETE RESTRICT,
  sequence_order     INT NOT NULL DEFAULT 1,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_follow_up_rules_updated_at
  BEFORE UPDATE ON whatsapp_hub.follow_up_rules
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();
