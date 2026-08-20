-- ============================================================================
-- Multi-tenancy · Parte 2/3: org_id em todas as tabelas de domínio + backfill
-- ----------------------------------------------------------------------------
-- · Cria a org padrão ('Organização Principal') e move TODOS os dados atuais
--   para ela; o admin mais antigo vira super admin.
-- · Adiciona org_id (NOT NULL + FK) nas ~45 tabelas de domínio.
-- · DEFAULTs: org_id DEFAULT current_org_id() (JWT) — para o frontend; nas
--   integrações single-org legadas (landing/sales),
--   fallback default_org_id(). Tabelas-filhas ganham trigger BEFORE INSERT
--   que herda o org da linha-pai (webhooks/funções service-role).
-- · Reescreve UNIQUEs/PKs para escopo por org e recria índices quentes.
-- · Copia as credenciais de public.app_settings → public.org_settings da org
--   padrão e carimba org_id/is_super_admin no raw_app_meta_data de todos os
--   usuários existentes.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Org padrão + coluna org_id + backfill + NOT NULL + FK, tabela a tabela.
--    webhook_events fica NULLABLE (log de integração acessado só via
--    service role).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_org UUID;
  t TEXT;
  v_not_null_tables TEXT[] := ARRAY[
    'contacts', 'tags', 'contact_tags', 'templates', 'campaigns',
    'campaign_contacts', 'follow_up_rules', 'follow_up_log', 'conversations',
    'messages', 'knowledge_base', 'knowledge_chunks', 'ai_agent_config',
    'ai_agent_media', 'notifications', 'app_settings', 'pipelines', 'stages',
    'deals', 'deal_products', 'deal_tags', 'projects', 'project_tasks',
    'courses', 'classes', 'enrollments', 'crm_activities', 'crm_ai_actions',
    'lead_stage_history', 'interaction_notes', 'contact_interactions',
    'contact_channel_links', 'utm_links',
    'repurchase_config', 'repurchase_predictions', 'sales_records',
    'dashboard_preferences', 'lead_assignment_queue', 'products',
    'custom_fields', 'custom_field_values', 'funnel_automations'
  ];
  v_nullable_tables TEXT[] := ARRAY['webhook_events'];
BEGIN
  -- Org padrão (idempotente).
  SELECT id INTO v_org FROM whatsapp_hub.organizations WHERE slug = 'principal';
  IF v_org IS NULL THEN
    INSERT INTO whatsapp_hub.organizations (name, slug)
    VALUES ('Organização Principal', 'principal')
    RETURNING id INTO v_org;
  END IF;

  FOREACH t IN ARRAY v_not_null_tables LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ADD COLUMN IF NOT EXISTS org_id UUID', t);
    EXECUTE format('UPDATE whatsapp_hub.%I SET org_id = %L WHERE org_id IS NULL', t, v_org);
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ALTER COLUMN org_id SET NOT NULL', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = t || '_org_id_fkey'
         AND conrelid = format('whatsapp_hub.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE whatsapp_hub.%I ADD CONSTRAINT %I FOREIGN KEY (org_id) '
        || 'REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE',
        t, t || '_org_id_fkey');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON whatsapp_hub.%I (org_id)',
                   'idx_' || t || '_org', t);
  END LOOP;

  FOREACH t IN ARRAY v_nullable_tables LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ADD COLUMN IF NOT EXISTS org_id UUID', t);
    EXECUTE format('UPDATE whatsapp_hub.%I SET org_id = %L WHERE org_id IS NULL', t, v_org);
  END LOOP;

  -- app_users: todos os usuários atuais pertencem à org padrão.
  UPDATE whatsapp_hub.app_users SET org_id = v_org WHERE org_id IS NULL;
  ALTER TABLE whatsapp_hub.app_users ALTER COLUMN org_id SET NOT NULL;

  -- O admin mais antigo da instância vira super admin.
  UPDATE whatsapp_hub.app_users
     SET is_super_admin = true
   WHERE id = (
     SELECT id FROM whatsapp_hub.app_users
      WHERE role = 'admin'
      ORDER BY created_at
      LIMIT 1
   );

  -- Espelha org_id / home_org_id / is_super_admin no JWT de todos os usuários.
  UPDATE auth.users u
     SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'org_id',         au.org_id::text,
                                'home_org_id',    au.org_id::text,
                                'is_super_admin', au.is_super_admin
                              )
    FROM whatsapp_hub.app_users au
   WHERE au.user_id = u.id;

  -- Copia o cofre global para o cofre por-org da org padrão.
  INSERT INTO public.org_settings (org_id, key, value_encrypted, updated_at)
  SELECT v_org, s.key, s.value_encrypted, s.updated_at
    FROM public.app_settings s
  ON CONFLICT (org_id, key) DO NOTHING;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. DEFAULTs de org_id.
--    · Padrão: current_org_id() — INSERT do frontend herda a org do JWT;
--      service role sem org explícito falha (NOT NULL), como deve ser.
--    · Integrações single-org legadas: fallback default_org_id().
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  v_strict TEXT[] := ARRAY[
    'tags', 'contact_tags', 'templates', 'campaigns', 'campaign_contacts',
    'follow_up_rules', 'follow_up_log', 'conversations', 'messages',
    'knowledge_base', 'knowledge_chunks', 'ai_agent_config', 'ai_agent_media',
    'notifications', 'app_settings', 'pipelines', 'stages', 'deals',
    'deal_products', 'deal_tags', 'projects', 'project_tasks', 'courses',
    'classes', 'enrollments', 'crm_activities', 'crm_ai_actions',
    'lead_stage_history', 'interaction_notes', 'contact_interactions',
    'contact_channel_links', 'repurchase_config',
    'dashboard_preferences', 'lead_assignment_queue', 'products',
    'custom_fields', 'custom_field_values', 'funnel_automations'
  ];
  v_fallback TEXT[] := ARRAY[
    'contacts', 'sales_records', 'utm_links', 'repurchase_predictions',
    'webhook_events'
  ];
BEGIN
  FOREACH t IN ARRAY v_strict LOOP
    EXECUTE format(
      'ALTER TABLE whatsapp_hub.%I ALTER COLUMN org_id SET DEFAULT whatsapp_hub.current_org_id()', t);
  END LOOP;
  FOREACH t IN ARRAY v_fallback LOOP
    EXECUTE format(
      'ALTER TABLE whatsapp_hub.%I ALTER COLUMN org_id SET DEFAULT '
      || 'COALESCE(whatsapp_hub.current_org_id(), whatsapp_hub.default_org_id())', t);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Triggers de herança: filhas herdam org_id da linha-pai quando o INSERT
--    veio sem org (Edge Functions/funções SQL legadas via service role).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  spec TEXT[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['conversations',        'contacts',             'contact_id'],
    ARRAY['messages',             'conversations',        'conversation_id'],
    ARRAY['notifications',        'conversations',        'conversation_id'],
    ARRAY['campaign_contacts',    'campaigns',            'campaign_id'],
    ARRAY['knowledge_chunks',     'knowledge_base',       'knowledge_base_id'],
    ARRAY['contact_tags',         'contacts',             'contact_id'],
    ARRAY['deals',                'contacts',             'contact_id'],
    ARRAY['deal_products',        'deals',                'deal_id'],
    ARRAY['deal_tags',            'deals',                'deal_id'],
    ARRAY['custom_field_values',  'custom_fields',        'custom_field_id'],
    ARRAY['projects',             'contacts',             'contact_id'],
    ARRAY['project_tasks',        'projects',             'project_id'],
    ARRAY['stages',               'pipelines',            'pipeline_id'],
    ARRAY['classes',              'courses',              'course_id'],
    ARRAY['enrollments',          'classes',              'class_id'],
    ARRAY['crm_activities',       'contacts',             'contact_id'],
    ARRAY['crm_ai_actions',       'contacts',             'contact_id'],
    ARRAY['lead_stage_history',   'deals',                'deal_id'],
    ARRAY['contact_interactions', 'contacts',             'contact_id'],
    ARRAY['interaction_notes',    'contact_interactions', 'interaction_id'],
    ARRAY['contact_channel_links','contacts',             'contact_id'],
    ARRAY['follow_up_log',        'follow_up_rules',      'rule_id']
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_org_from_parent ON whatsapp_hub.%I', spec[1]);
    EXECUTE format(
      'CREATE TRIGGER trg_org_from_parent BEFORE INSERT ON whatsapp_hub.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_parent(%L, %L)',
      spec[1], spec[2], spec[3]);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. UNIQUEs / PKs reescritos para escopo por org.
-- ----------------------------------------------------------------------------

-- contacts: telefone único POR ORG (era global).
ALTER TABLE whatsapp_hub.contacts
  DROP CONSTRAINT IF EXISTS contacts_phone_key;
ALTER TABLE whatsapp_hub.contacts
  ADD CONSTRAINT contacts_org_phone_key UNIQUE (org_id, phone);
DROP INDEX IF EXISTS whatsapp_hub.contacts_instagram_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_instagram_id_key
  ON whatsapp_hub.contacts (org_id, instagram_id) WHERE instagram_id IS NOT NULL;

-- tags / templates: nome único por org.
ALTER TABLE whatsapp_hub.tags
  DROP CONSTRAINT IF EXISTS tags_name_key;
ALTER TABLE whatsapp_hub.tags
  ADD CONSTRAINT tags_org_name_key UNIQUE (org_id, name);

ALTER TABLE whatsapp_hub.templates
  DROP CONSTRAINT IF EXISTS templates_name_key;
ALTER TABLE whatsapp_hub.templates
  ADD CONSTRAINT templates_org_name_key UNIQUE (org_id, name);

-- conversations: 1 conversa por contato (contato já é org-scoped).
ALTER TABLE whatsapp_hub.conversations
  DROP CONSTRAINT IF EXISTS conversations_contact_id_key;
ALTER TABLE whatsapp_hub.conversations
  ADD CONSTRAINT conversations_org_contact_key UNIQUE (org_id, contact_id);

-- messages: dedup do id de mensagem do provider por org.
DROP INDEX IF EXISTS whatsapp_hub.uq_messages_meta_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_zernio_message_id
  ON whatsapp_hub.messages (org_id, zernio_message_id)
  WHERE zernio_message_id IS NOT NULL;

-- app_settings: singleton POR ORG (era singleton global id=1).
-- Remove PK/CHECK antigos por catálogo (nomes podem variar) e re-ancora em org_id.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'whatsapp_hub.app_settings'::regclass
       AND contype IN ('p', 'c')
  LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.app_settings DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;
ALTER TABLE whatsapp_hub.app_settings
  ADD CONSTRAINT app_settings_pkey PRIMARY KEY (org_id);
-- id (smallint DEFAULT 1) permanece por compat: queries .eq('id', 1) seguem
-- funcionando — a RLS restringe à linha da própria org.

-- ai_agent_config: 1 config por org (era índice singleton global).
DROP INDEX IF EXISTS whatsapp_hub.ai_agent_config_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_config_org_key
  ON whatsapp_hub.ai_agent_config (org_id);

-- repurchase_config: idem (era id int PK DEFAULT 1).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'whatsapp_hub.repurchase_config'::regclass
       AND contype = 'p'
  LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.repurchase_config DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;
ALTER TABLE whatsapp_hub.repurchase_config
  ADD CONSTRAINT repurchase_config_pkey PRIMARY KEY (org_id);

-- lead_assignment_queue: fila de round-robin por org.
ALTER TABLE whatsapp_hub.lead_assignment_queue
  DROP CONSTRAINT IF EXISTS lead_assignment_queue_pkey;
ALTER TABLE whatsapp_hub.lead_assignment_queue
  ADD CONSTRAINT lead_assignment_queue_pkey PRIMARY KEY (org_id, user_id);

-- sales_records / repurchase_predictions: dedupe por org.
ALTER TABLE whatsapp_hub.sales_records
  DROP CONSTRAINT IF EXISTS sales_records_customer_doc_product_name_purchase_date_key;
ALTER TABLE whatsapp_hub.sales_records
  ADD CONSTRAINT sales_records_org_dedupe_key
  UNIQUE (org_id, customer_doc, product_name, purchase_date);

ALTER TABLE whatsapp_hub.repurchase_predictions
  DROP CONSTRAINT IF EXISTS repurchase_predictions_customer_doc_product_name_key;
ALTER TABLE whatsapp_hub.repurchase_predictions
  ADD CONSTRAINT repurchase_predictions_org_key
  UNIQUE (org_id, customer_doc, product_name);

-- contact_channel_links: identidade de canal única por org.
ALTER TABLE whatsapp_hub.contact_channel_links
  DROP CONSTRAINT IF EXISTS contact_channel_links_channel_channel_identifier_key;
ALTER TABLE whatsapp_hub.contact_channel_links
  ADD CONSTRAINT contact_channel_links_org_channel_key
  UNIQUE (org_id, channel, channel_identifier);

-- dashboard_preferences: default + override por (org, user, widget).
DROP INDEX IF EXISTS whatsapp_hub.dashboard_prefs_user_widget;
DROP INDEX IF EXISTS whatsapp_hub.dashboard_prefs_default_widget;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_prefs_user_widget
  ON whatsapp_hub.dashboard_preferences (org_id, user_id, widget_key)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_prefs_default_widget
  ON whatsapp_hub.dashboard_preferences (org_id, widget_key)
  WHERE user_id IS NULL;

-- ----------------------------------------------------------------------------
-- 5. Índices compostos quentes.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_conversations_org_last_msg
  ON whatsapp_hub.conversations (org_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_messages_org_conversation
  ON whatsapp_hub.messages (org_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_org_phone
  ON whatsapp_hub.contacts (org_id, phone);
CREATE INDEX IF NOT EXISTS idx_deals_org_stage
  ON whatsapp_hub.deals (org_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_org_pending
  ON whatsapp_hub.campaign_contacts (org_id, created_at)
  WHERE status = 'pending';
