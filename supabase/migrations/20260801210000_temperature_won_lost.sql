-- ============================================================================
-- Regra de temperatura por resultado do deal (backfill)
-- ----------------------------------------------------------------------------
-- Ganho  → cliente Morno (não Quente).
-- Perdido → volta a Lead Frio (sem badge de cliente).
-- A regra passa a ser aplicada pelo board (moveDeal); aqui só alinhamos os
-- deals já existentes.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

UPDATE whatsapp_hub.deals
SET temperature = 'Morno'
WHERE status = 'won' AND temperature IS DISTINCT FROM 'Morno';

UPDATE whatsapp_hub.deals
SET temperature = 'Frio', lead_type = 'Lead'
WHERE status = 'lost'
  AND (temperature IS DISTINCT FROM 'Frio' OR lead_type IS DISTINCT FROM 'Lead');
