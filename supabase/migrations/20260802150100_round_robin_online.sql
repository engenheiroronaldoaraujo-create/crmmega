-- ============================================================================
-- Distribuição automática de leads: rodízio honra is_online
-- ----------------------------------------------------------------------------
-- O round-robin do handoff (20260721120100) atribuía a qualquer membro da
-- fila, online ou não (divergindo do comportamento documentado). Agora pula
-- quem está offline: percorre a fila a partir do cursor e escolhe o primeiro
-- operador com app_users.is_online = true. Sem ninguém online, não atribui
-- (o fanout de notificação para a equipe continua cobrindo o handoff).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_autoassign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_enabled boolean;
  v_cursor uuid;
  v_next uuid;
BEGIN
  -- Só no handoff (ai_paused false→true) e sem responsável definido.
  IF NOT (COALESCE(OLD.ai_paused, false) = false AND NEW.ai_paused = true) THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT auto_assign_enabled, auto_assign_last_user_id
    INTO v_enabled, v_cursor
  FROM app_settings
  ORDER BY id
  LIMIT 1;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Próximo da fila DEPOIS do cursor, apenas operadores online.
  SELECT q.user_id INTO v_next
  FROM lead_assignment_queue q
  JOIN app_users au ON au.user_id = q.user_id
  WHERE au.is_online = true
    AND (v_cursor IS NULL OR (q.position, q.user_id) > (
      SELECT q2.position, q2.user_id FROM lead_assignment_queue q2 WHERE q2.user_id = v_cursor
    ))
  ORDER BY q.position, q.user_id
  LIMIT 1;

  -- Fim da fila (ou cursor inválido): recomeça do início, ainda só online.
  IF v_next IS NULL THEN
    SELECT q.user_id INTO v_next
    FROM lead_assignment_queue q
    JOIN app_users au ON au.user_id = q.user_id
    WHERE au.is_online = true
    ORDER BY q.position, q.user_id
    LIMIT 1;
  END IF;

  IF v_next IS NULL THEN
    RETURN NEW; -- fila vazia ou ninguém online
  END IF;

  NEW.assigned_to := v_next;
  NEW.assigned_at := now();
  UPDATE app_settings SET auto_assign_last_user_id = v_next, updated_at = now();

  RETURN NEW;
END;
$$;
