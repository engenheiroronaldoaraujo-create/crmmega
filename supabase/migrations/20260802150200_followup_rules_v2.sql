-- ============================================================================
-- Follow-ups v2 (aba Automações): novos gatilhos + canal UAZAPI
-- ----------------------------------------------------------------------------
-- Regras deixam de ser só "no_reply" (reengajamento de broadcast):
--   · inactivity  — contato sem mensagem inbound há X horas (params.hours)
--   · no_purchase — cliente sem compra há X dias (params.days)
-- Canal por regra: 'zernio' (API oficial — template aprovado) ou 'uazapi'
-- (não oficial — texto livre em message_text; risco de banimento maior,
-- avisado na UI). Filtros opcionais em params: {temperature, lead_type, tag_id}.
-- follow_up_log deduplica: 1 disparo por regra × contato.
-- OBS: ALTER TYPE ... ADD VALUE não roda em transaction — aplicar cada
-- statement isoladamente via Management API.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TYPE whatsapp_hub.follow_up_trigger ADD VALUE IF NOT EXISTS 'inactivity';
ALTER TYPE whatsapp_hub.follow_up_trigger ADD VALUE IF NOT EXISTS 'no_purchase';

ALTER TABLE whatsapp_hub.follow_up_rules
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'zernio',
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;

-- template_id passa a ser opcional (regras UAZAPI usam message_text).
ALTER TABLE whatsapp_hub.follow_up_rules ALTER COLUMN template_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_hub.follow_up_log (
  rule_id    UUID NOT NULL REFERENCES whatsapp_hub.follow_up_rules(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, contact_id)
);

ALTER TABLE whatsapp_hub.follow_up_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_up_log_select ON whatsapp_hub.follow_up_log;
CREATE POLICY follow_up_log_select ON whatsapp_hub.follow_up_log
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON whatsapp_hub.follow_up_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.follow_up_log TO service_role;
