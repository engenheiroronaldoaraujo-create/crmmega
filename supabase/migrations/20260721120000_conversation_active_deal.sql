-- ============================================================================
-- Negócio ativo na conversa — vincula uma conversa a um deal em foco.
-- Independente de assigned_to (responsável da conversa) e de owner_id (dono do
-- negócio). ON DELETE SET NULL: apagar o deal só desvincula.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS active_deal_id UUID
    REFERENCES whatsapp_hub.deals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_active_deal_idx
  ON whatsapp_hub.conversations(active_deal_id);
