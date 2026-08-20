-- ============================================================================
-- Módulo 3 · Suporte de dados para o Dashboard de vendas + atendimento
-- ----------------------------------------------------------------------------
-- Adaptado ao schema real: o "lead" é whatsapp_hub.deals; "pipeline_stages" é
-- whatsapp_hub.stages; não há org_id (mono-org). Adiciona:
--   1. deals: lost_reason, first_contact_at, first_response_at
--      (deals já tem status open|won|lost, won_at, lost_at, value, owner_id).
--   2. stages.probability (0..100) para o forecast.
--   3. Trigger que sincroniza won_at/lost_at ao mudar deals.status.
--   4. Trigger que carimba first_contact_at / first_response_at a partir das
--      mensagens do inbox.
--   5. dashboard_preferences (toggle de widgets por usuário + default da
--      instância).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Colunas de vendas/atendimento em deals ---------------------------------
ALTER TABLE whatsapp_hub.deals
  ADD COLUMN IF NOT EXISTS lost_reason        TEXT,
  ADD COLUMN IF NOT EXISTS first_contact_at   TIMESTAMPTZ,  -- 1ª msg do lead
  ADD COLUMN IF NOT EXISTS first_response_at  TIMESTAMPTZ;  -- 1ª resposta humana

CREATE INDEX IF NOT EXISTS idx_deals_status_owner ON whatsapp_hub.deals(status, owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_won_at  ON whatsapp_hub.deals(won_at);
CREATE INDEX IF NOT EXISTS idx_deals_lost_at ON whatsapp_hub.deals(lost_at);

-- 2. Probabilidade por estágio (forecast) -----------------------------------
ALTER TABLE whatsapp_hub.stages
  ADD COLUMN IF NOT EXISTS probability INT NOT NULL DEFAULT 0;
-- Clamp defensivo 0..100.
DO $$ BEGIN
  ALTER TABLE whatsapp_hub.stages
    ADD CONSTRAINT stages_probability_range CHECK (probability BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Sincroniza won_at/lost_at conforme deals.status -------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._sync_deal_outcome_ts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won' THEN
    NEW.won_at := COALESCE(NEW.won_at, now());
    NEW.lost_at := NULL;
  ELSIF NEW.status = 'lost' AND OLD.status IS DISTINCT FROM 'lost' THEN
    NEW.lost_at := COALESCE(NEW.lost_at, now());
    NEW.won_at := NULL;
  ELSIF NEW.status = 'open' AND OLD.status IS DISTINCT FROM 'open' THEN
    NEW.won_at := NULL;
    NEW.lost_at := NULL;
    NEW.lost_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_outcome_ts ON whatsapp_hub.deals;
CREATE TRIGGER trg_deals_outcome_ts
  BEFORE UPDATE OF status ON whatsapp_hub.deals
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._sync_deal_outcome_ts();

-- 4. Carimba first_contact_at / first_response_at a partir das mensagens ------
-- first_contact_at: 1ª mensagem inbound do contato.
-- first_response_at: 1ª mensagem outbound de um OPERADOR humano (IA não conta).
CREATE OR REPLACE FUNCTION whatsapp_hub._touch_deal_response_times()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_contact UUID;
BEGIN
  IF COALESCE(NEW.is_private_note, false) = true THEN
    RETURN NEW;
  END IF;

  SELECT contact_id INTO v_contact FROM whatsapp_hub.conversations WHERE id = NEW.conversation_id;
  IF v_contact IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.direction = 'inbound' AND NEW.sender_type = 'contact' THEN
    UPDATE whatsapp_hub.deals
       SET first_contact_at = NEW.created_at
     WHERE contact_id = v_contact AND first_contact_at IS NULL;
  ELSIF NEW.direction = 'outbound' AND NEW.sender_type = 'operator' THEN
    UPDATE whatsapp_hub.deals
       SET first_response_at = NEW.created_at
     WHERE contact_id = v_contact AND first_response_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_deal_response_times ON whatsapp_hub.messages;
CREATE TRIGGER trg_touch_deal_response_times
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._touch_deal_response_times();

-- 5. Preferências de widgets do dashboard -----------------------------------
-- user_id NULL = default da instância (definido por admin). Cada usuário pode
-- sobrescrever a visibilidade/ordem para si.
CREATE TABLE IF NOT EXISTS whatsapp_hub.dashboard_preferences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  widget_key TEXT NOT NULL,
  visible    BOOLEAN NOT NULL DEFAULT true,
  position   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Um registro por (usuário, widget); e um único default (user_id NULL) por widget.
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_prefs_user_widget
  ON whatsapp_hub.dashboard_preferences(user_id, widget_key) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_prefs_default_widget
  ON whatsapp_hub.dashboard_preferences(widget_key) WHERE user_id IS NULL;

ALTER TABLE whatsapp_hub.dashboard_preferences ENABLE ROW LEVEL SECURITY;

-- Cada um lê as próprias prefs + os defaults da instância.
DROP POLICY IF EXISTS dashboard_prefs_select ON whatsapp_hub.dashboard_preferences;
CREATE POLICY dashboard_prefs_select ON whatsapp_hub.dashboard_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL);

-- Cada um gerencia as próprias prefs.
DROP POLICY IF EXISTS dashboard_prefs_write_own ON whatsapp_hub.dashboard_preferences;
CREATE POLICY dashboard_prefs_write_own ON whatsapp_hub.dashboard_preferences
  FOR ALL TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Só admin gerencia o default da instância (user_id NULL).
DROP POLICY IF EXISTS dashboard_prefs_write_default ON whatsapp_hub.dashboard_preferences;
CREATE POLICY dashboard_prefs_write_default ON whatsapp_hub.dashboard_preferences
  FOR ALL TO authenticated
  USING      (user_id IS NULL AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (user_id IS NULL AND whatsapp_hub.current_user_role() = 'admin');
