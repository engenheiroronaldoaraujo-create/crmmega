-- ============================================================================
-- IA por número: channels.ai_enabled
-- ----------------------------------------------------------------------------
-- Um número compartilhado pela equipe usa IA + rodízio; um número pessoal de
-- vendedor normalmente não quer IA respondendo. Este toggle refina a IA por
-- número — o master switch da plataforma continua sendo
-- ai_agent_config.active_whatsapp / active_instagram (ambos precisam estar
-- ligados para a IA responder). Com ai_enabled = false, a conversa nova nasce
-- e é imediatamente flipada para human_active + ai_paused = true (o flip
-- dispara os triggers de handoff: notifica o operador vinculado ao número ou
-- cai no rodízio/fanout quando o número não tem dono).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.channels
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true;
