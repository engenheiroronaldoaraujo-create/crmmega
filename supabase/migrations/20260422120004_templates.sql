-- ============================================================================
-- Module 1 · Templates (WhatsApp Message Templates)
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- meta_template_id is the id returned by Meta when the template is approved.
-- meta_template_status mirrors the raw Meta status string (for diagnostics)
-- while `status` is the normalized lifecycle enum used by the UI.

CREATE TABLE whatsapp_hub.templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  category              whatsapp_hub.template_category NOT NULL,
  language              TEXT NOT NULL DEFAULT 'pt_BR',
  status                whatsapp_hub.template_status NOT NULL DEFAULT 'draft',
  meta_template_id      TEXT,
  meta_template_status  TEXT,
  header_type           whatsapp_hub.header_type NOT NULL DEFAULT 'none',
  header_content        TEXT,
  body                  TEXT NOT NULL,
  footer                TEXT,
  buttons               JSONB NOT NULL DEFAULT '[]'::jsonb,
  variables             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_prompt             TEXT,
  submitted_at          TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON whatsapp_hub.templates
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();
