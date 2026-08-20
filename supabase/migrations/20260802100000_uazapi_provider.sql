-- ============================================================================
-- Provedor do WhatsApp por conversa (Meta oficial × UAZAPI)
-- ----------------------------------------------------------------------------
-- O usuário opera dois números no Zernio: um pela API oficial da Meta (janela
-- de 24h) e um pela UAZAPI (sem janela). O webhook passa a carimbar a conta
-- Zernio que recebeu cada mensagem em conversations.zernio_account_id; a conta
-- UAZAPI é declarada em app_settings.uazapi_account_id (singleton — leitura
-- por qualquer autenticado, escrita admin-only pela RLS existente).
-- Conversa UAZAPI = channel 'whatsapp' + zernio_account_id = uazapi_account_id
-- → inbox sem trava de 24h e badge "UAZAPI"; demais WhatsApp = "WhatsApp Meta".
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS zernio_account_id TEXT;

ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS uazapi_account_id TEXT;
