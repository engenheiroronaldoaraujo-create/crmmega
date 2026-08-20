-- ============================================================================
-- Provider por conversa: 'zernio' (WhatsApp Meta oficial / Instagram) × 'uazapi'
-- ----------------------------------------------------------------------------
-- A UAZAPI é integração DIRETA (server URL + instance token + webhook próprio
-- uazapi-webhook), não passa pelo Zernio. O webhook da UAZAPI cria conversas
-- com provider='uazapi'; envio (operador/IA) roteia pela API da UAZAPI.
-- Substitui a abordagem anterior por accountId do Zernio (descartada).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'zernio';

-- Abordagem anterior (conta UAZAPI dentro do Zernio) — coluna descartada.
ALTER TABLE whatsapp_hub.app_settings
  DROP COLUMN IF EXISTS uazapi_account_id;
