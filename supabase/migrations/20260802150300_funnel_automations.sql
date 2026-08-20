-- ============================================================================
-- Automações de Funil (aba Automações → Funil)
-- ----------------------------------------------------------------------------
-- Regra: quando um deal ENTRA numa etapa → executa ações (JSONB array):
--   add_tag{tag_id} · next_action{action_type, delay_hours, note} ·
--   set_lead_type{value} · set_temperature{value} · send_template{template_id}
--   · send_text{text} · assign{user_id} · add_to_pipeline{pipeline_id, stage_id}
-- Trigger em deals (INSERT ou UPDATE de stage_id) → Edge Function
-- funnel-automation via pg_net (helper _invoke_edge_with_body já existente,
-- com Vault). A função executa as ações server-side.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.funnel_automations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES whatsapp_hub.pipelines(id) ON DELETE CASCADE,
  stage_id    UUID NOT NULL REFERENCES whatsapp_hub.stages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funnel_automations_stage ON whatsapp_hub.funnel_automations(stage_id) WHERE is_active;

ALTER TABLE whatsapp_hub.funnel_automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS funnel_automations_select ON whatsapp_hub.funnel_automations;
CREATE POLICY funnel_automations_select ON whatsapp_hub.funnel_automations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS funnel_automations_admin_write ON whatsapp_hub.funnel_automations;
CREATE POLICY funnel_automations_admin_write ON whatsapp_hub.funnel_automations
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.funnel_automations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.funnel_automations TO service_role;

-- Trigger: deal entrou numa etapa → invoca a Edge Function (só se houver
-- automação ativa para a etapa — evita HTTP à toa em todo movimento).
CREATE OR REPLACE FUNCTION whatsapp_hub._on_deal_stage_automation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  IF NEW.stage_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM funnel_automations fa WHERE fa.stage_id = NEW.stage_id AND fa.is_active
  ) THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'funnel-automation',
      jsonb_build_object('deal_id', NEW.id, 'stage_id', NEW.stage_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_deal_stage_automation ON whatsapp_hub.deals;
CREATE TRIGGER on_deal_stage_automation
  AFTER INSERT OR UPDATE OF stage_id ON whatsapp_hub.deals
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_deal_stage_automation();
