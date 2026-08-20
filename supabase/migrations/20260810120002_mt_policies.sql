-- ============================================================================
-- Multi-tenancy · Parte 3/3: RLS org-scoped + funções org-aware
-- ----------------------------------------------------------------------------
-- · Dropa TODAS as policies do schema whatsapp_hub e recria com o predicado
--   único `org_id = current_org_id() AND current_org_active()` (+ gate de
--   role). Org arquivada = acesso zero via RLS.
-- · Super admin NÃO enxerga dados de domínio — só gerencia organizations e
--   app_users; para suporte ele troca a claim org_id (api/admin/switch-org).
-- · Reescreve as funções que eram instance-wide: fanout de notificações,
--   handoff, round-robin (fila+cursor por org), knowledge_search (filtro por
--   org), list_operators (org + display_name/avatar) e
--   compute_repurchase_predictions (agrupada por org). sales_dashboard e
--   crm_promote_deal_to_project viram SECURITY INVOKER (a RLS passa a valer).
--   De quebra conserta o _on_handoff_notify de 20260721120100, que ainda
--   referenciava NEW.tenant_id (coluna extinta) e quebrava em runtime.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Drop de todas as policies do schema (catálogo — imune a renomeações).
-- ----------------------------------------------------------------------------

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'whatsapp_hub'
  LOOP
    EXECUTE format('DROP POLICY %I ON whatsapp_hub.%I', r.policyname, r.tablename);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Policies padrão por tier de escrita.
--    SELECT: qualquer membro autenticado DA ORG (org ativa).
--    WRITE: gate por role (admin-only ou admin+operator), sempre org-scoped.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  v_admin_write TEXT[] := ARRAY[
    'templates', 'campaigns', 'campaign_contacts', 'follow_up_rules',
    'knowledge_base', 'knowledge_chunks', 'ai_agent_config', 'app_settings',
    'lead_assignment_queue', 'funnel_automations', 'ai_agent_media',
    'custom_fields', 'repurchase_config', 'sales_records', 'channels'
  ];
  v_operator_write TEXT[] := ARRAY[
    'contacts', 'tags', 'contact_tags', 'conversations', 'messages',
    'custom_field_values', 'contact_channel_links', 'contact_interactions',
    'interaction_notes', 'lead_stage_history', 'deal_products', 'deal_tags',
    'products', 'utm_links', 'repurchase_predictions', 'pipelines', 'stages',
    'deals', 'projects', 'project_tasks', 'courses', 'classes', 'enrollments',
    'crm_activities', 'crm_ai_actions'
  ];
  -- Escrita apenas via service role (Edge Functions / API routes).
  v_select_only TEXT[] := ARRAY['follow_up_log'];
BEGIN
  FOREACH t IN ARRAY v_admin_write LOOP
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated '
      || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active())',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR ALL TO authenticated '
      || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
      ||        'AND whatsapp_hub.current_user_role() = ''admin'') '
      || 'WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
      ||        'AND whatsapp_hub.current_user_role() = ''admin'')',
      t || '_admin_write', t);
  END LOOP;

  FOREACH t IN ARRAY v_operator_write LOOP
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated '
      || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active())',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR ALL TO authenticated '
      || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
      ||        'AND whatsapp_hub.current_user_role() IN (''admin'', ''operator'')) '
      || 'WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
      ||        'AND whatsapp_hub.current_user_role() IN (''admin'', ''operator''))',
      t || '_write', t);
  END LOOP;

  FOREACH t IN ARRAY v_select_only LOOP
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated '
      || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active())',
      t || '_select', t);
  END LOOP;
END;
$$;

-- webhook_events: RLS ligado SEM policies — service role only (inalterado).

-- ----------------------------------------------------------------------------
-- 3. Policies especiais.
-- ----------------------------------------------------------------------------

-- organizations: membro vê a PRÓPRIA org (mesmo arquivada — para a tela de
-- "organização desativada"); super admin vê e gerencia todas.
CREATE POLICY orgs_member_select ON whatsapp_hub.organizations
  FOR SELECT TO authenticated
  USING (id = whatsapp_hub.current_org_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY orgs_super_admin_write ON whatsapp_hub.organizations
  FOR ALL TO authenticated
  USING (whatsapp_hub.is_super_admin())
  WITH CHECK (whatsapp_hub.is_super_admin());

-- app_users: membros da org se enxergam (nome/avatar no inbox); admin da org
-- gerencia; cada um atualiza o próprio perfil/presença (o trigger guard abaixo
-- impede escalada de role/org/super-admin); super admin lê tudo (console).
CREATE POLICY app_users_org_select ON whatsapp_hub.app_users
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR org_id = whatsapp_hub.current_org_id()
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY app_users_admin_write ON whatsapp_hub.app_users
  FOR ALL TO authenticated
  USING (
    org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY app_users_self_update ON whatsapp_hub.app_users
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Guard anti-escalada: campos sensíveis de app_users só mudam pela service
-- role (API routes/Edge Functions) ou por admin da org (role apenas).
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service role (sem JWT de usuário) passa direto.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Campo protegido de app_users só pode ser alterado pelo super admin.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     AND whatsapp_hub.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Apenas admins alteram roles.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_users_guard ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_guard
  BEFORE UPDATE ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_guard();

-- notifications: por usuário, dentro da org.
CREATE POLICY notifications_self ON whatsapp_hub.notifications
  FOR ALL TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
  )
  WITH CHECK (
    user_id = auth.uid()
    AND org_id = whatsapp_hub.current_org_id()
  );

-- dashboard_preferences: leitura org; default (user_id NULL) admin; override próprio.
CREATE POLICY dashboard_prefs_select ON whatsapp_hub.dashboard_preferences
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

CREATE POLICY dashboard_prefs_write_default ON whatsapp_hub.dashboard_preferences
  FOR ALL TO authenticated
  USING (
    user_id IS NULL
    AND org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    user_id IS NULL
    AND org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY dashboard_prefs_write_own ON whatsapp_hub.dashboard_preferences
  FOR ALL TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id = whatsapp_hub.current_org_id()
    AND whatsapp_hub.current_org_active()
  )
  WITH CHECK (
    user_id = auth.uid()
    AND org_id = whatsapp_hub.current_org_id()
  );

-- ----------------------------------------------------------------------------
-- 4. Notificações: fanout / inbound / handoff — escopo por org.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS whatsapp_hub._fanout_notification(
  whatsapp_hub.notification_type, UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS whatsapp_hub._fanout_notification(
  UUID, whatsapp_hub.notification_type, UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION whatsapp_hub._fanout_notification(
  p_org             UUID,
  p_type            whatsapp_hub.notification_type,
  p_conversation_id UUID,
  p_message_id      UUID,
  p_title           TEXT,
  p_body            TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.notifications (
    org_id, user_id, type, conversation_id, message_id, title, body
  )
  SELECT p_org, u.user_id, p_type, p_conversation_id, p_message_id, p_title, p_body
    FROM whatsapp_hub.app_users u
   WHERE u.org_id = p_org
     AND u.role IN ('admin', 'operator');
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub._on_inbound_notify()
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
  IF NEW.direction <> 'inbound'
     OR NEW.sender_type <> 'contact'
     OR COALESCE(NEW.is_private_note, false) = true
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.conversations conv
    JOIN whatsapp_hub.contacts c ON c.id = conv.contact_id
   WHERE conv.id = NEW.conversation_id;

  title_txt := 'Nova mensagem de ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato');
  body_txt  := LEFT(COALESCE(NEW.content, '[' || NEW.content_type::text || ']'), 140);

  PERFORM whatsapp_hub._fanout_notification(
    NEW.org_id,
    'new_message'::whatsapp_hub.notification_type,
    NEW.conversation_id,
    NEW.id,
    title_txt,
    body_txt
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_inbound_notify ON whatsapp_hub.messages;
CREATE TRIGGER on_inbound_notify
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._on_inbound_notify();

-- Versão final do notify de handoff (substitui a de 20260721120100, que ainda
-- referenciava NEW.tenant_id): responsável definido → notifica só ele; senão
-- fanout para a equipe DA ORG.
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
    INSERT INTO whatsapp_hub.notifications (
      org_id, user_id, type, conversation_id, message_id, title, body
    )
    VALUES (
      NEW.org_id, NEW.assigned_to, 'handoff'::whatsapp_hub.notification_type,
      NEW.id, NULL, title_txt, body_txt
    );
  ELSE
    PERFORM whatsapp_hub._fanout_notification(
      NEW.org_id,
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

DROP TRIGGER IF EXISTS on_handoff_notify ON whatsapp_hub.conversations;
CREATE TRIGGER on_handoff_notify
  AFTER UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._on_handoff_notify();

-- ----------------------------------------------------------------------------
-- 5. Round-robin do handoff: fila e cursor POR ORG (cursor vive na linha de
--    app_settings da org). Continua honrando is_online.
-- ----------------------------------------------------------------------------

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
  IF NOT (COALESCE(OLD.ai_paused, false) = false AND NEW.ai_paused = true) THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT auto_assign_enabled, auto_assign_last_user_id
    INTO v_enabled, v_cursor
    FROM whatsapp_hub.app_settings
   WHERE org_id = NEW.org_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT q.user_id INTO v_next
    FROM whatsapp_hub.lead_assignment_queue q
    JOIN whatsapp_hub.app_users au ON au.user_id = q.user_id AND au.org_id = NEW.org_id
   WHERE q.org_id = NEW.org_id
     AND au.is_online = true
     AND (v_cursor IS NULL OR (q.position, q.user_id) > (
       SELECT q2.position, q2.user_id
         FROM whatsapp_hub.lead_assignment_queue q2
        WHERE q2.org_id = NEW.org_id AND q2.user_id = v_cursor
     ))
   ORDER BY q.position, q.user_id
   LIMIT 1;

  IF v_next IS NULL THEN
    SELECT q.user_id INTO v_next
      FROM whatsapp_hub.lead_assignment_queue q
      JOIN whatsapp_hub.app_users au ON au.user_id = q.user_id AND au.org_id = NEW.org_id
     WHERE q.org_id = NEW.org_id
       AND au.is_online = true
     ORDER BY q.position, q.user_id
     LIMIT 1;
  END IF;

  IF v_next IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.assigned_to := v_next;
  NEW.assigned_at := now();
  UPDATE whatsapp_hub.app_settings
     SET auto_assign_last_user_id = v_next, updated_at = now()
   WHERE org_id = NEW.org_id;

  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. knowledge_search: filtro por org. Edge Functions (service role) passam
--    p_org_id explicitamente; chamadas de usuário caem em current_org_id().
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS whatsapp_hub.knowledge_search(vector, INT);

CREATE OR REPLACE FUNCTION whatsapp_hub.knowledge_search(
  p_query_embedding vector(1536),
  p_top_k           INT DEFAULT 5,
  p_org_id          UUID DEFAULT NULL
)
RETURNS TABLE (
  id                UUID,
  knowledge_base_id UUID,
  content           TEXT,
  similarity        REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_org UUID := COALESCE(p_org_id, whatsapp_hub.current_org_id());
BEGIN
  IF v_org IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    kc.id,
    kc.knowledge_base_id,
    kc.content,
    (1 - (kc.embedding <=> p_query_embedding))::real AS similarity
  FROM whatsapp_hub.knowledge_chunks kc
  WHERE kc.embedding IS NOT NULL
    AND kc.org_id = v_org
  ORDER BY kc.embedding <=> p_query_embedding
  LIMIT GREATEST(1, LEAST(p_top_k, 50));
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(vector, INT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(vector, INT, UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. list_operators: membros DA ORG + perfil (display_name / avatar).
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS whatsapp_hub.list_operators();

CREATE FUNCTION whatsapp_hub.list_operators()
RETURNS TABLE (
  user_id      uuid,
  email        text,
  role         whatsapp_hub.tenant_role,
  display_name text,
  avatar_url   text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, public, pg_temp
AS $$
  SELECT au.user_id, u.email::text, au.role, au.display_name, au.avatar_url
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
   WHERE au.org_id = whatsapp_hub.current_org_id()
   ORDER BY au.role, COALESCE(au.display_name, u.email::text);
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_operators() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_operators() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. RPCs de agregação: RLS passa a valer via SECURITY INVOKER (o corpo não
--    muda; as policies org-scoped fazem o recorte). Service role segue com
--    acesso total (BYPASSRLS).
-- ----------------------------------------------------------------------------

ALTER FUNCTION whatsapp_hub.sales_dashboard(int) SECURITY INVOKER;
ALTER FUNCTION whatsapp_hub.crm_promote_deal_to_project(UUID) SECURITY INVOKER;

-- ----------------------------------------------------------------------------
-- 9. compute_repurchase_predictions: agrupa por org, respeita o min_purchases
--    da config de cada org e carimba org_id nas predições. Só service role
--    (o cron recalcula todas as orgs ativas de uma vez).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.compute_repurchase_predictions()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH cfg AS (
    SELECT o.id AS org_id, COALESCE(rc.min_purchases, 3) AS min_purchases
      FROM whatsapp_hub.organizations o
      LEFT JOIN whatsapp_hub.repurchase_config rc ON rc.org_id = o.id
     WHERE o.status = 'active'
  ),
  agg AS (
    SELECT
      sr.org_id, sr.customer_doc, sr.product_name,
      max(sr.customer_phone) FILTER (WHERE sr.customer_phone IS NOT NULL) AS customer_phone,
      max(sr.customer_name)  FILTER (WHERE sr.customer_name  IS NOT NULL) AS customer_name,
      count(DISTINCT sr.purchase_date) AS purchase_count,
      min(sr.purchase_date) AS first_purchase,
      max(sr.purchase_date) AS last_purchase
    FROM whatsapp_hub.sales_records sr
    JOIN cfg ON cfg.org_id = sr.org_id
    WHERE sr.customer_doc IS NOT NULL
    GROUP BY sr.org_id, sr.customer_doc, sr.product_name
    HAVING count(DISTINCT sr.purchase_date) >= max(cfg.min_purchases)
  ),
  calc AS (
    SELECT org_id, customer_doc, product_name, customer_phone, customer_name,
           purchase_count, last_purchase,
      GREATEST(1, round((last_purchase - first_purchase)::numeric
        / NULLIF(purchase_count - 1, 0)))::int AS avg_interval_days
    FROM agg
  ),
  upsert AS (
    INSERT INTO whatsapp_hub.repurchase_predictions
      (org_id, customer_doc, customer_phone, customer_name, product_name,
       avg_interval_days, purchase_count, last_purchase, predicted_next,
       status, updated_at)
    SELECT org_id, customer_doc, COALESCE(customer_phone, ''), customer_name,
      product_name, avg_interval_days, purchase_count, last_purchase,
      last_purchase + avg_interval_days, 'pending', now()
    FROM calc
    ON CONFLICT (org_id, customer_doc, product_name) DO UPDATE SET
      customer_phone = EXCLUDED.customer_phone,
      customer_name = EXCLUDED.customer_name,
      avg_interval_days = EXCLUDED.avg_interval_days,
      purchase_count = EXCLUDED.purchase_count,
      last_purchase = EXCLUDED.last_purchase,
      predicted_next = EXCLUDED.predicted_next,
      status = CASE WHEN EXCLUDED.last_purchase > whatsapp_hub.repurchase_predictions.last_purchase
                    THEN 'pending' ELSE whatsapp_hub.repurchase_predictions.status END,
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upsert;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.compute_repurchase_predictions() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.compute_repurchase_predictions() TO service_role;

-- ----------------------------------------------------------------------------
-- 10. Storage: bucket de knowledge passa a exigir prefixo da org no path
--     (uploads novos: <org_id>/<uuid>.pdf). Arquivos legados ficam acessíveis
--     apenas via service role (os chunks já estão no banco).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS wh_knowledge_read         ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_insert ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_update ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_delete ON storage.objects;

CREATE POLICY wh_knowledge_org_read
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
  );

CREATE POLICY wh_knowledge_org_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
  );

CREATE POLICY wh_knowledge_org_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
  );
