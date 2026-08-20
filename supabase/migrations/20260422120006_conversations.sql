-- ============================================================================
-- Module 1 · Conversations & Messages (Inbox)
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- conversations
-- ----------------------------------------------------------------------------
-- One conversation per (tenant, contact). Status tracks who is driving the
-- conversation (AI vs. human vs. closed). ai_paused is a soft-pause flag the
-- operator can toggle independently of status (e.g. AI on but muted briefly).

CREATE TABLE whatsapp_hub.conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  status           whatsapp_hub.conversation_status NOT NULL DEFAULT 'ai_active',
  assigned_to      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at      TIMESTAMPTZ,
  ai_paused        BOOLEAN NOT NULL DEFAULT false,
  last_message_at  TIMESTAMPTZ,
  unread_count     INT NOT NULL DEFAULT 0,
  closed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id)
);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- messages
-- ----------------------------------------------------------------------------
-- sender_id is nullable: system/AI messages have no user; operator messages
-- reference auth.users(id). is_private_note=true means operator-only note,
-- never sent to the contact.

CREATE TABLE whatsapp_hub.messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES whatsapp_hub.conversations(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  direction         whatsapp_hub.message_direction NOT NULL,
  sender_type       whatsapp_hub.sender_type NOT NULL,
  sender_id         UUID,
  content_type      whatsapp_hub.content_type NOT NULL DEFAULT 'text',
  content           TEXT,
  media_url         TEXT,
  meta_message_id   TEXT,
  meta_status       whatsapp_hub.meta_message_status,
  is_private_note   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
