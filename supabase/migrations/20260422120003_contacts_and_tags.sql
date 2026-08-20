-- ============================================================================
-- Module 1 · Contacts, Tags, Contact Tags
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- contacts
-- ----------------------------------------------------------------------------
-- phone is stored in E.164 (+55...); deduplication is enforced per tenant.

CREATE TABLE whatsapp_hub.contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  phone          TEXT NOT NULL,
  name           TEXT,
  email          TEXT,
  custom_fields  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON whatsapp_hub.contacts
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- tags
-- ----------------------------------------------------------------------------

CREATE TABLE whatsapp_hub.tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3B82F6',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TRIGGER trg_tags_updated_at
  BEFORE UPDATE ON whatsapp_hub.tags
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- contact_tags (junction)
-- ----------------------------------------------------------------------------
-- tenant_id is denormalized here so RLS can filter without joining contacts.

CREATE TABLE whatsapp_hub.contact_tags (
  contact_id  UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES whatsapp_hub.tags(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
