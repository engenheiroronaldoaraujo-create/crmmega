-- ============================================================================
-- 20260802190000_message_delivery_status
-- ----------------------------------------------------------------------------
-- Status real de entrega no espelho da inbox dos disparos em massa.
--
-- Problema: o dispatch-campaign espelha cada destinatario do broadcast como uma
-- mensagem outbound com meta_status='sent' fixo e SEM vinculo com a linha de
-- campaign_contacts. Quando o sync-broadcast-status descobre a falha no Zernio,
-- so campaign_contacts é atualizado — a mensagem da inbox fica "enviada" para
-- sempre e o motivo da falha nunca aparece para o operador.
--
-- 1. messages.campaign_contact_id — vincula o espelho da inbox à linha da
--    campanha, permitindo ao sync propagar sent/delivered/read/failed.
-- 2. messages.error_reason — motivo legivel da falha (broadcast via sync;
--    mensagens 1:1 via campo `error` do webhook do Zernio).
-- 3. Backfill best-effort: marca como failed os espelhos presos em 'sent' cujo
--    campaign_contact ja falhou (match por conversa do contato + janela de
--    10min ao redor do sent_at).
-- ============================================================================

SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.messages
  ADD COLUMN IF NOT EXISTS campaign_contact_id uuid
    REFERENCES whatsapp_hub.campaign_contacts(id) ON DELETE SET NULL;

ALTER TABLE whatsapp_hub.messages
  ADD COLUMN IF NOT EXISTS error_reason text;

CREATE INDEX IF NOT EXISTS messages_campaign_contact_id_idx
  ON whatsapp_hub.messages (campaign_contact_id)
  WHERE campaign_contact_id IS NOT NULL;

-- Backfill: espelhos de campanha presos em 'sent' cuja linha ja falhou.
UPDATE whatsapp_hub.messages m
SET meta_status = 'failed',
    error_reason = cc.error_message,
    campaign_contact_id = cc.id
FROM whatsapp_hub.campaign_contacts cc
JOIN whatsapp_hub.conversations cv ON cv.contact_id = cc.contact_id
WHERE cc.status = 'failed'
  AND cc.sent_at IS NOT NULL
  AND m.conversation_id = cv.id
  AND m.direction = 'outbound'
  AND m.sender_type = 'system'
  AND m.content_type = 'template'
  AND m.meta_status = 'sent'
  AND m.campaign_contact_id IS NULL
  AND m.created_at BETWEEN cc.sent_at - interval '10 minutes'
                       AND cc.sent_at + interval '10 minutes';
