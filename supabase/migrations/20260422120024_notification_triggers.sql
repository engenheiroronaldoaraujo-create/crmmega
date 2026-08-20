-- ============================================================================
-- Module 12 · Notification pipeline — inbound messages + handoff events
-- ============================================================================
-- Pure DB-side: two triggers fan out into whatsapp_hub.notifications so every
-- member of the tenant (admin + operator) sees the event in the in-app
-- notification tray. The UI subscribes to notifications via Realtime so it
-- shows up without any extra HTTP round-trip.
--
-- Kept as triggers (not Edge Functions) because no outbound IO is required
-- here — insertion alone is enough for the Realtime channel to light up.
-- Email / Web Push delivery can be layered on top later by an async worker
-- reading from the same table.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Helper: insert one notification row per eligible tenant member.
-- Filters to admins + operators by default; viewers don't get pinged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._fanout_notification(
  p_tenant_id      UUID,
  p_type           whatsapp_hub.notification_type,
  p_conversation_id UUID,
  p_message_id     UUID,
  p_title          TEXT,
  p_body           TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.notifications (
    tenant_id, user_id, type, conversation_id, message_id, title, body
  )
  SELECT
    p_tenant_id,
    tm.user_id,
    p_type,
    p_conversation_id,
    p_message_id,
    p_title,
    p_body
  FROM whatsapp_hub.tenant_members tm
  WHERE tm.tenant_id = p_tenant_id
    AND tm.role IN ('admin', 'operator');
END;
$$;

-- ----------------------------------------------------------------------------
-- Trigger 1 — inbound message from a contact creates a 'new_message' notif.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_inbound_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
  title_txt TEXT;
  body_txt TEXT;
BEGIN
  IF NEW.direction <> 'inbound'
     OR NEW.sender_type <> 'contact'
     OR COALESCE(NEW.is_private_note, false) = true
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.conversations conv
    JOIN whatsapp_hub.contacts c ON c.id = conv.contact_id
   WHERE conv.id = NEW.conversation_id;

  title_txt := 'Nova mensagem de ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato');
  body_txt  := LEFT(COALESCE(NEW.content, '[' || NEW.content_type::text || ']'), 140);

  PERFORM whatsapp_hub._fanout_notification(
    NEW.tenant_id,
    'new_message'::whatsapp_hub.notification_type,
    NEW.conversation_id,
    NEW.id,
    title_txt,
    body_txt
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_inbound_notify ON whatsapp_hub.messages;
CREATE TRIGGER on_inbound_notify
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_inbound_notify();

-- ----------------------------------------------------------------------------
-- Trigger 2 — AI → human handoff raises a 'handoff' notif.
-- Fires when ai_paused transitions from false/null to true.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
BEGIN
  IF COALESCE(OLD.ai_paused, false) = true
     OR COALESCE(NEW.ai_paused, false) = false
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.contacts c
   WHERE c.id = NEW.contact_id;

  PERFORM whatsapp_hub._fanout_notification(
    NEW.tenant_id,
    'handoff'::whatsapp_hub.notification_type,
    NEW.id,
    NULL,
    'Handoff para humano: ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato'),
    'A IA foi pausada nessa conversa. Ela precisa de um atendente humano.'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_handoff_notify ON whatsapp_hub.conversations;
CREATE TRIGGER on_handoff_notify
  AFTER UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_handoff_notify();
