-- ============================================================================
-- Módulo 8 · IA move o lead automaticamente pelo funil
-- ----------------------------------------------------------------------------
-- Adaptado ao schema real: "lead" = whatsapp_hub.deals; "pipeline_stages" =
-- whatsapp_hub.stages; sem org_id. Adiciona:
--   1. stages.ai_criteria — descrição/critério que diz à IA o que caracteriza
--      o estágio (sem critério → a IA não move para ele).
--   2. ai_agent_config.auto_move_leads — liga/desliga o movimento automático.
--   3. lead_stage_history — auditoria de toda movimentação (IA ou humano).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Critério de IA por estágio ---------------------------------------------
ALTER TABLE whatsapp_hub.stages
  ADD COLUMN IF NOT EXISTS ai_criteria TEXT;

-- 2. Toggle do movimento automático -----------------------------------------
ALTER TABLE whatsapp_hub.ai_agent_config
  ADD COLUMN IF NOT EXISTS auto_move_leads BOOLEAN NOT NULL DEFAULT true;

-- 3. Histórico de movimentação de estágio -----------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.lead_stage_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID NOT NULL REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  from_stage_id UUID REFERENCES whatsapp_hub.stages(id) ON DELETE SET NULL,
  to_stage_id   UUID NOT NULL REFERENCES whatsapp_hub.stages(id) ON DELETE CASCADE,
  moved_by      TEXT NOT NULL CHECK (moved_by IN ('ia', 'humano')),
  actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- quando humano
  reason        TEXT,                                                -- resumo quando IA
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_deal
  ON whatsapp_hub.lead_stage_history(deal_id, created_at DESC);

ALTER TABLE whatsapp_hub.lead_stage_history ENABLE ROW LEVEL SECURITY;

-- Leitura aberta a autenticados; escrita por admin/operator (movimentos manuais
-- da UI). A IA grava via service role (Edge Function), que ignora RLS.
DROP POLICY IF EXISTS lead_stage_history_read ON whatsapp_hub.lead_stage_history;
CREATE POLICY lead_stage_history_read ON whatsapp_hub.lead_stage_history
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS lead_stage_history_write ON whatsapp_hub.lead_stage_history;
CREATE POLICY lead_stage_history_write ON whatsapp_hub.lead_stage_history
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin', 'operator'));
