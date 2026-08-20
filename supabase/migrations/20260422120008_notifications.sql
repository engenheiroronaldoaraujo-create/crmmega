-- ============================================================================
-- Module 1 · Notifications
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE TABLE whatsapp_hub.notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type             whatsapp_hub.notification_type NOT NULL,
  conversation_id  UUID REFERENCES whatsapp_hub.conversations(id) ON DELETE CASCADE,
  message_id       UUID REFERENCES whatsapp_hub.messages(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  body             TEXT,
  is_read          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
