-- ============================================================================
-- 20260624120000_expose_postgrest_schema
-- ----------------------------------------------------------------------------
-- Expõe o schema `whatsapp_hub` no PostgREST (Data API do Supabase). Sem isto,
-- toda query do frontend (`supabase.schema('whatsapp_hub')...`) volta com
-- PGRST106 "Invalid schema: whatsapp_hub" / HTTP 406 — o app inteiro fica sem
-- dados mesmo com as tabelas e RLS corretos.
--
-- No Supabase Cloud, os schemas expostos são lidos da config do role
-- `authenticator` (GUC `pgrst.db_schemas`). O `config.toml` só cobre o ambiente
-- local do CLI. Esta migration roda via /database/query (como postgres), que
-- tem permissão para alterar o authenticator.
--
-- Idempotente e não-destrutiva: lê os schemas atuais e só ANEXA `whatsapp_hub`
-- se ainda não estiver presente — preserva outros apps Agentise que compartilhem
-- o mesmo Supabase (agentise_chat, prospector, crm_sofia, ...).
-- ============================================================================

DO $$
DECLARE
  schemas text;
BEGIN
  SELECT split_part(cfg, '=', 2) INTO schemas
  FROM (SELECT unnest(rolconfig) AS cfg FROM pg_roles WHERE rolname = 'authenticator') s
  WHERE cfg LIKE 'pgrst.db_schemas=%';

  -- Default do Supabase quando o role ainda não tem a GUC definida.
  IF schemas IS NULL OR btrim(schemas) = '' THEN
    schemas := 'public, graphql_public';
  END IF;

  IF position('whatsapp_hub' IN schemas) = 0 THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', schemas || ', whatsapp_hub');
  END IF;
END
$$;

-- Recarrega a config (lista de schemas expostos) E o cache de schema
-- (tabelas/colunas) do PostgREST sem reiniciar o projeto. Os dois são
-- necessários: 'reload config' faz o whatsapp_hub passar a ser exposto;
-- 'reload schema' faz o PostgREST introspectar as tabelas do schema recém
-- exposto — sem ele as queries voltam PGRST205 "Could not find the table".
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
