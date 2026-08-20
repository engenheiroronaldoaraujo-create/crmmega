-- ============================================================================
-- 20260623120000_zernio_schema
-- ----------------------------------------------------------------------------
-- Suporte de schema para a migracao Meta Cloud API → Zernio (Modulo 2).
--
--   1. Renomeia messages/campaign_contacts.meta_message_id → zernio_message_id
--      (id externo do Zernio). Recria o indice unico parcial de dedup.
--   2. Adiciona zernio_conversation_id em conversations e campaign_contacts.
--   3. Adiciona zernio_broadcast_id em campaigns e campaign_contacts
--      (correlacao exata dos webhooks de status de broadcast por destinatario).
--   4. Cria whatsapp_hub.webhook_events para idempotencia do zernio-webhook.
--   5. Desagenda o cron wh-check-template-status (status agora chega pelo
--      evento whatsapp.template.status_updated; a Edge Function foi removida).
--
-- meta_status (enum de status de entrega) e mantido como esta — e generico e
-- renomea-lo tocaria os tipos do frontend; representa o status relayado pelo
-- Zernio. Os ajustes de dados restantes (formato de components, mapeamento de
-- variaveis, remocao do tier manual e do Resend) ficam para o Modulo 3.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Rename meta_message_id → zernio_message_id ------------------------------
ALTER TABLE whatsapp_hub.messages           RENAME COLUMN meta_message_id TO zernio_message_id;
ALTER TABLE whatsapp_hub.campaign_contacts  RENAME COLUMN meta_message_id TO zernio_message_id;

-- Recria o indice unico parcial de dedup com o novo nome de coluna.
DROP INDEX IF EXISTS whatsapp_hub.uq_messages_meta_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_zernio_message_id
  ON whatsapp_hub.messages (zernio_message_id)
  WHERE zernio_message_id IS NOT NULL;

-- 2. zernio_conversation_id --------------------------------------------------
ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS zernio_conversation_id TEXT;
ALTER TABLE whatsapp_hub.campaign_contacts
  ADD COLUMN IF NOT EXISTS zernio_conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_zernio_conversation_id
  ON whatsapp_hub.conversations (zernio_conversation_id)
  WHERE zernio_conversation_id IS NOT NULL;

-- 3. zernio_broadcast_id -----------------------------------------------------
ALTER TABLE whatsapp_hub.campaigns
  ADD COLUMN IF NOT EXISTS zernio_broadcast_id TEXT;
ALTER TABLE whatsapp_hub.campaign_contacts
  ADD COLUMN IF NOT EXISTS zernio_broadcast_id TEXT;

-- O webhook de status localiza o destinatario por (broadcast + contato).
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_zernio_broadcast_id
  ON whatsapp_hub.campaign_contacts (zernio_broadcast_id, contact_id)
  WHERE zernio_broadcast_id IS NOT NULL;

-- 4. webhook_events (idempotencia) -------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.webhook_events (
  zernio_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_hub.webhook_events ENABLE ROW LEVEL SECURITY;
-- Sem policies: somente a service role (Edge Functions) le/escreve.

-- Higiene: descarta eventos antigos para a tabela nao crescer indefinidamente.
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
  ON whatsapp_hub.webhook_events (processed_at);

-- 5. Desagenda o cron de polling de template --------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('wh-check-template-status');
EXCEPTION WHEN OTHERS THEN
  NULL; -- nao agendado nesta instancia; ignora
END
$$;
