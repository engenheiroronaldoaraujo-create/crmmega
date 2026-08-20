-- ============================================================================
-- 20260610130000_messages_wamid_dedup
-- ----------------------------------------------------------------------------
-- Fecha o último furo crítico de idempotência do webhook (auditoria de QA):
--
--   Os webhooks inbound da Meta são at-least-once. Quando o endpoint demora a
--   responder 200 (ou devolve 5xx), a Meta REENVIA o mesmo `messages[]` com o
--   mesmo `id` (wamid). O handler antigo fazia INSERT incondicional em
--   `messages`, então um reenvio criava uma 2ª linha inbound → o trigger
--   `_on_inbound_message` disparava `process-ai-message` de novo → a IA
--   respondia e ENVIAVA ao cliente duas vezes.
--
--   Defesa em profundidade: índice único parcial sobre `meta_message_id`. Com
--   ele, um INSERT duplicado falha com 23505 em vez de criar a linha — o
--   handler trata isso como "já processado" e segue. O guard de existência no
--   próprio handler (select-before-insert) cobre o caso comum sem gerar erro.
--
--   Observação: o índice é parcial (WHERE meta_message_id IS NOT NULL) porque
--   notas privadas e mensagens de sistema não têm wamid. Mensagens outbound
--   também guardam o wamid devolvido pela Meta, mas wamids são globalmente
--   únicos, então não há colisão legítima entre inbound e outbound.
-- ============================================================================

SET search_path TO whatsapp_hub;

-- Instalações novas (template) não têm dados, então não há duplicatas a limpar.
-- Em instalações já populadas, remova duplicatas antes de criar o índice:
-- mantém a linha mais antiga por wamid e descarta as repetidas.
DELETE FROM whatsapp_hub.messages m
 USING whatsapp_hub.messages dup
 WHERE m.meta_message_id IS NOT NULL
   AND m.meta_message_id = dup.meta_message_id
   AND m.ctid > dup.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_meta_message_id
  ON whatsapp_hub.messages (meta_message_id)
  WHERE meta_message_id IS NOT NULL;
