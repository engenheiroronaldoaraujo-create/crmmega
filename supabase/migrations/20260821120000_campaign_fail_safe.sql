-- ============================================================================
-- 20260821120000_campaign_fail_safe
-- ----------------------------------------------------------------------------
-- Adiciona colunas de fail-safe na tabela campaigns para que o dispatcher
-- persista contagem de erros consecutivos entre ticks do cron.
--
-- Problema: o dispatch-campaign pulava campanhas com erros (credenciais
-- ausentes, Zernio fora do ar, etc.) e a campanha ficava em 'sending' para
-- sempre, sem visibilidade do erro.
--
-- Solução: contador persistido + mensagem de erro. Após N erros consecutivos
-- sem progresso, a campanha vai para 'failed' automaticamente.
-- ============================================================================

SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.campaigns
  ADD COLUMN IF NOT EXISTS consecutive_errors INT NOT NULL DEFAULT 0;

ALTER TABLE whatsapp_hub.campaigns
  ADD COLUMN IF NOT EXISTS last_error TEXT;
