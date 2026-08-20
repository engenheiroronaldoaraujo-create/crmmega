-- ============================================================================
-- 20260625130000_conversation_archive
-- ----------------------------------------------------------------------------
-- Arquivar/desarquivar conversas. `archived` é ortogonal ao status
-- (ai_active/human_active/closed): uma conversa pode estar arquivada em
-- qualquer status. O inbox esconde arquivadas por padrão e tem um filtro
-- "Arquivadas".
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_conversations_archived
  ON whatsapp_hub.conversations (archived, last_message_at DESC);
