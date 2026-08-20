-- ============================================================================
-- Module 6 · pg_cron: poll Meta for template approvals every 5 minutes
-- ============================================================================
-- pg_cron runs SQL snippets on a schedule. To call our Edge Function we use
-- pg_net's net.http_post with an Authorization header carrying the Supabase
-- service_role key.
--
-- The URL and the service_role key are not persisted as GUCs (Supabase cloud
-- blocks ALTER DATABASE SET). Instead we stash them in Supabase Vault — the
-- same mechanism migration 12 uses for the pgcrypto key. The cron job reads
-- them via a SECURITY DEFINER helper so the scheduled SQL doesn't need to
-- hit the vault directly every tick.
--
-- The push-migrations script substitutes the __SUPABASE_URL__ and
-- __SUPABASE_SERVICE_ROLE_KEY__ placeholders at deploy time so the plain
-- values never land in git.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Persist URL + service_role_key in Vault (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'whatsapp_hub_supabase_url') THEN
    PERFORM vault.create_secret(
      '__SUPABASE_URL__',
      'whatsapp_hub_supabase_url',
      'Project URL used by pg_cron jobs to reach Edge Functions'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'whatsapp_hub_service_role_key') THEN
    PERFORM vault.create_secret(
      '__SUPABASE_SERVICE_ROLE_KEY__',
      'whatsapp_hub_service_role_key',
      'Service role JWT used by pg_cron to authenticate to Edge Functions'
    );
  END IF;
END
$$;

-- 2. Helper that dispatches a cron tick to an Edge Function. Encapsulates the
--    Vault lookup so the cron schedule itself stays a one-liner.
CREATE OR REPLACE FUNCTION whatsapp_hub._cron_invoke_edge(function_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
DECLARE
  base_url TEXT;
  sr_key   TEXT;
  req_id   BIGINT;
BEGIN
  SELECT decrypted_secret INTO base_url FROM vault.decrypted_secrets WHERE name = 'whatsapp_hub_supabase_url';
  SELECT decrypted_secret INTO sr_key   FROM vault.decrypted_secrets WHERE name = 'whatsapp_hub_service_role_key';

  IF base_url IS NULL OR sr_key IS NULL THEN
    RAISE EXCEPTION 'Vault secrets whatsapp_hub_supabase_url / whatsapp_hub_service_role_key missing';
  END IF;

  SELECT net.http_post(
    url     := base_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || sr_key,
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb
  ) INTO req_id;

  RETURN req_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub._cron_invoke_edge(TEXT) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._cron_invoke_edge(TEXT) TO service_role;

-- 3. Schedule the job. If a previous version exists, unschedule first so the
--    migration is idempotent on re-runs.
DO $$
BEGIN
  PERFORM cron.unschedule('wh-check-template-status');
EXCEPTION WHEN OTHERS THEN
  -- no prior schedule; safe to ignore
  NULL;
END
$$;

SELECT cron.schedule(
  'wh-check-template-status',
  '*/5 * * * *',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('check-template-status')$cron$
);
