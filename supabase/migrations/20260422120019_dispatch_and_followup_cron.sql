-- ============================================================================
-- Module 7 · Dispatch + Follow-up cron jobs
-- ============================================================================
-- Adds two pg_cron jobs that drive the campaign pipeline:
--
--   wh-dispatch-campaigns   every 30s   → processes pending campaign_contacts
--   wh-check-follow-ups     every 15m   → enqueues follow-ups for no-reply
--
-- Also adds campaign_contacts.template_id_override: follow-up rules point to
-- a different template than the parent campaign, so the dispatcher reads the
-- override when present and falls back to campaigns.template_id otherwise.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Per-row template override, used by follow-ups.
ALTER TABLE whatsapp_hub.campaign_contacts
  ADD COLUMN IF NOT EXISTS template_id_override UUID
  REFERENCES whatsapp_hub.templates(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_template_override
  ON whatsapp_hub.campaign_contacts(template_id_override)
  WHERE template_id_override IS NOT NULL;

-- 2. Cron jobs. Unschedule first so re-runs of this migration are idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('wh-dispatch-campaigns');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('wh-check-follow-ups');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

-- pg_cron supports sub-minute syntax via the `%d seconds` extension phrasing.
SELECT cron.schedule(
  'wh-dispatch-campaigns',
  '30 seconds',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('dispatch-campaign')$cron$
);

SELECT cron.schedule(
  'wh-check-follow-ups',
  '*/15 * * * *',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('check-follow-ups')$cron$
);
