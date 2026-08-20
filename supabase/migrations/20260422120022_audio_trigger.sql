-- ============================================================================
-- Module 10 · Transcription pipeline — audio inbound fires transcribe-audio
-- ============================================================================
-- A second trigger on whatsapp_hub.messages: when an inbound audio message
-- arrives (from a contact, not a note), fire transcribe-audio so Whisper can
-- convert it to text in message.content. The existing on_inbound_message
-- trigger still fires in parallel; it skips audio rows (content_type check)
-- so the AI agent only answers once the transcription lands (second UPDATE
-- doesn't retrigger INSERT-only triggers, so for Whisper-transcribed audio
-- the AI pipeline currently doesn't re-run — tracked for Module 11).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub._on_audio_inbound()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  IF NEW.direction = 'inbound'
     AND NEW.sender_type = 'contact'
     AND NEW.content_type = 'audio'
     AND COALESCE(NEW.is_private_note, false) = false
     AND NEW.media_url IS NOT NULL
  THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'transcribe-audio',
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_audio_inbound ON whatsapp_hub.messages;
CREATE TRIGGER on_audio_inbound
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_audio_inbound();
