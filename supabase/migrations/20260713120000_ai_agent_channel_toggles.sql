-- ============================================================================
-- Módulo 6 · Agente de IA por canal (WhatsApp / Instagram)
-- ----------------------------------------------------------------------------
-- O agente pode ser ligado/desligado por canal de forma independente. Quando
-- está desligado para um canal, process-ai-message não gera resposta e roteia a
-- conversa daquele canal direto para atendimento humano.
--
-- Defaults: WhatsApp ligado (comportamento atual preservado), Instagram
-- desligado (opt-in explícito).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.ai_agent_config
  ADD COLUMN IF NOT EXISTS active_whatsapp  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS active_instagram BOOLEAN NOT NULL DEFAULT false;
