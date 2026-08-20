-- ============================================================================
-- 20260430120003_drop_onboarding.sql
-- ----------------------------------------------------------------------------
-- Fase 5 — Achatar onboarding wizard.
--
-- Após mover Step4Agent / Step5Hours / Step6Team para Settings, o flag
-- `onboarding_completed` em app_settings deixa de ter sentido. A tabela
-- app_settings já foi criada na Fase 4 (20260430120002_drop_multitenant.sql)
-- com business_hours / out_of_hours_message / onboarding_completed; aqui
-- removemos apenas a coluna do flag.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.app_settings
  DROP COLUMN IF EXISTS onboarding_completed;
