-- ============================================================================
-- Módulo 2 · Cron do disparo automático de recompra
-- ============================================================================
-- Agenda a Edge Function repurchase-dispatch (deployada junto desta migração)
-- diariamente às 09:15 — 15 min depois do cálculo de predições (09:00) — via
-- o helper existente _cron_invoke_edge (pg_net + service token da Vault).
--
-- A função tem kill-switch: com repurchase_config.auto_send = false (default),
-- o run inteiro é curto-circuitado e NADA é enviado. Guardrails na função:
-- kill-switch → template configurado → horário comercial → cooldown → E.164 →
-- auditoria em crm_ai_actions.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('repurchase-dispatch-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule(
  'repurchase-dispatch-daily',
  '15 9 * * *',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('repurchase-dispatch')$cron$
);
