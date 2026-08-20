-- ============================================================================
-- Arquivamento de deals no funil
-- ----------------------------------------------------------------------------
-- Botão "Arquivar" no card do funil: o deal sai do board (sem excluir) e fica
-- acessível na visão "Arquivados", de onde pode ser restaurado.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.deals
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Board filtra por archived_at IS NULL; índice parcial mantém a query barata.
CREATE INDEX IF NOT EXISTS idx_deals_archived
  ON whatsapp_hub.deals (pipeline_id)
  WHERE archived_at IS NOT NULL;
