-- ============================================================================
-- Module 9 · AI pipeline trigger — inbound message fires process-ai-message
-- ============================================================================
-- Adds a second Edge-Function-invocation helper that carries a JSONB body,
-- and a trigger on whatsapp_hub.messages that fires process-ai-message with
-- the new message_id whenever an inbound contact message lands.
--
-- The trigger fires AFTER INSERT so the row is fully visible when the Edge
-- Function reads it. It filters inside the function body (not WHEN clause)
-- so SECURITY DEFINER context has access to all fields.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Generic helper: call any Edge Function with a custom body payload.
CREATE OR REPLACE FUNCTION whatsapp_hub._invoke_edge_with_body(
  function_name TEXT,
  payload       JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
DECLARE
  base_url TEXT;
  sr_key   TEXT;
  req_id   BIGINT;
BEGIN
  SELECT decrypted_secret INTO base_url FROM vault.decrypted_secrets WHERE name = 'whatsapp_hub_supabase_url';
  SELECT decrypted_secret INTO sr_key   FROM vault.decrypted_secrets WHERE name = 'whatsapp_hub_service_role_key';

  IF base_url IS NULL OR sr_key IS NULL THEN
    RAISE EXCEPTION 'Vault secrets whatsapp_hub_supabase_url / whatsapp_hub_service_role_key missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || sr_key,
      'Content-Type',  'application/json'
    ),
    body    := payload
  ) INTO req_id;

  RETURN req_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub._invoke_edge_with_body(TEXT, JSONB) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._invoke_edge_with_body(TEXT, JSONB) TO service_role;

-- Trigger function: fires the AI pipeline only for fresh inbound messages
-- from real contacts that should be answered.
CREATE OR REPLACE FUNCTION whatsapp_hub._on_inbound_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  IF NEW.direction = 'inbound'
     AND NEW.sender_type = 'contact'
     AND COALESCE(NEW.is_private_note, false) = false
  THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'process-ai-message',
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_inbound_message ON whatsapp_hub.messages;
CREATE TRIGGER on_inbound_message
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_inbound_message();
