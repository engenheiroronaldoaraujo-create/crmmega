-- ============================================================================
-- Module · pg_cron: sync broadcast delivery status every 2 minutes
-- ============================================================================
-- O evento de status do webhook do Zernio NAO carrega o broadcastId, entao a
-- entrega por destinatario de campanha (delivered/read/failed) nunca era
-- reconciliada em campaign_contacts — a linha ficava 'sent' para sempre e uma
-- falha de entrega sumia sem aviso.
--
-- Este job invoca a Edge Function sync-broadcast-status, que consulta
-- GET /broadcasts/{id}/recipients no Zernio e aplica o status por linha.
-- Reusa o helper _cron_invoke_edge (Vault + pg_net) ja definido na migration
-- 20260422120018.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Unschedule first so re-runs of this migration are idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('wh-sync-broadcast-status');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule(
  'wh-sync-broadcast-status',
  '*/2 * * * *',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('sync-broadcast-status')$cron$
);
