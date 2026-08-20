-- ============================================================================
-- 20260624150000_verify_service_token
-- ----------------------------------------------------------------------------
-- Conserta o 403 em TODAS as Edge Functions acionadas por pg_cron / pg_net
-- (dispatch-campaign, check-follow-ups, process-ai-message, transcribe-audio).
--
-- O cron/trigger autentica enviando o segredo da Vault
-- `whatsapp_hub_service_role_key`. A função comparava esse token com o
-- SUPABASE_SERVICE_ROLE_KEY injetado — que pode divergir do valor da Vault
-- (projetos no novo formato de API keys). Resultado: 403 em todo invoke,
-- travando campanhas, follow-ups, IA automática e transcrição.
--
-- Esta RPC permite que a função valide o token contra o PRÓPRIO segredo da
-- Vault (fonte única usada pelo cron), eliminando a dependência do formato/
-- valor da chave injetada.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.verify_service_token(p_token text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM vault.decrypted_secrets
     WHERE name = 'whatsapp_hub_service_role_key'
       AND decrypted_secret = p_token
  );
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.verify_service_token(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.verify_service_token(text) TO service_role;
