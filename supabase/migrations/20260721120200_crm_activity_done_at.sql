-- ============================================================================
-- Carimbo de conclusão das ações agendadas (crm_activities). A UI grava done_at
-- ao concluir uma ação; a timeline do contato usa done_at p/ a entrada
-- "concluída" (fallback created_at).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.crm_activities
  ADD COLUMN IF NOT EXISTS done_at timestamptz;
