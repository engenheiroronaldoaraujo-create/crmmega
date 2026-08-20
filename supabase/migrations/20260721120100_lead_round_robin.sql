-- ============================================================================
-- Distribuição automática (round-robin) de leads no handoff.
-- No handoff (ai_paused false→true), se a conversa não tem responsável e a
-- distribuição está ligada, atribui ao próximo da fila em sequência pura (wrap
-- ao fim) e avança o cursor. Não sobrescreve atribuição manual. Ignora presença.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Flags no singleton de settings da aplicação (id = 1).
ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS auto_assign_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_last_user_id uuid;  -- cursor do round-robin

-- Fila do round-robin: quem participa e em que ordem.
CREATE TABLE IF NOT EXISTS whatsapp_hub.lead_assignment_queue (
  user_id  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  position int  NOT NULL DEFAULT 0
);

ALTER TABLE whatsapp_hub.lead_assignment_queue ENABLE ROW LEVEL SECURITY;

-- SELECT aberto a authenticated; escrita apenas admin (via current_user_role()).
DROP POLICY IF EXISTS laq_select ON whatsapp_hub.lead_assignment_queue;
CREATE POLICY laq_select ON whatsapp_hub.lead_assignment_queue
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS laq_write ON whatsapp_hub.lead_assignment_queue;
CREATE POLICY laq_write ON whatsapp_hub.lead_assignment_queue
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- ----------------------------------------------------------------------------
-- Trigger BEFORE UPDATE: roda ANTES do AFTER UPDATE on_handoff_notify, então o
-- notify já enxerga o NEW.assigned_to preenchido por aqui.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_autoassign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_enabled boolean;
  v_cursor  uuid;
  v_next    uuid;
BEGIN
  -- Só no handoff false→true.
  IF COALESCE(OLD.ai_paused, false) = true
     OR COALESCE(NEW.ai_paused, false) = false
  THEN
    RETURN NEW;
  END IF;

  -- Nunca sobrescreve atribuição manual.
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT auto_assign_enabled, auto_assign_last_user_id
    INTO v_enabled, v_cursor
    FROM whatsapp_hub.app_settings
   WHERE id = 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Próximo da fila após o cursor (ordem pura por position, user_id).
  SELECT user_id INTO v_next
    FROM whatsapp_hub.lead_assignment_queue
   WHERE v_cursor IS NULL
      OR (position, user_id) > (
           SELECT position, user_id
             FROM whatsapp_hub.lead_assignment_queue
            WHERE user_id = v_cursor
         )
   ORDER BY position, user_id
   LIMIT 1;

  -- Wrap ao fim (ou cursor apontando p/ user que saiu da fila): pega o primeiro.
  IF v_next IS NULL THEN
    SELECT user_id INTO v_next
      FROM whatsapp_hub.lead_assignment_queue
     ORDER BY position, user_id
     LIMIT 1;
  END IF;

  -- Fila vazia → não atribui (o fanout à equipe continua valendo).
  IF v_next IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.assigned_to := v_next;
  NEW.assigned_at := now();

  UPDATE whatsapp_hub.app_settings
     SET auto_assign_last_user_id = v_next,
         updated_at = now()
   WHERE id = 1;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_handoff_autoassign ON whatsapp_hub.conversations;
CREATE TRIGGER on_handoff_autoassign
  BEFORE UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_handoff_autoassign();

-- ----------------------------------------------------------------------------
-- Ajuste do notify de handoff: se a conversa TEM responsável, notifica só ele;
-- senão mantém o fanout à equipe (admins + operadores).
-- Substitui a versão de 20260422120024_notification_triggers.sql.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
  title_txt TEXT;
  body_txt TEXT;
BEGIN
  IF COALESCE(OLD.ai_paused, false) = true
     OR COALESCE(NEW.ai_paused, false) = false
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.contacts c
   WHERE c.id = NEW.contact_id;

  title_txt := 'Handoff para humano: ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato');
  body_txt  := 'A IA foi pausada nessa conversa. Ela precisa de um atendente humano.';

  IF NEW.assigned_to IS NOT NULL THEN
    -- Conversa já tem responsável (manual ou round-robin) → notifica só ele.
    INSERT INTO whatsapp_hub.notifications (
      tenant_id, user_id, type, conversation_id, message_id, title, body
    )
    VALUES (
      NEW.tenant_id, NEW.assigned_to, 'handoff'::whatsapp_hub.notification_type,
      NEW.id, NULL, title_txt, body_txt
    );
  ELSE
    -- Sem responsável → fanout à equipe inteira.
    PERFORM whatsapp_hub._fanout_notification(
      NEW.tenant_id,
      'handoff'::whatsapp_hub.notification_type,
      NEW.id,
      NULL,
      title_txt,
      body_txt
    );
  END IF;

  RETURN NEW;
END;
$$;
