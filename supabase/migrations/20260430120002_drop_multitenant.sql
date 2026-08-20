-- ============================================================================
-- Phase 4 · Drop multi-tenancy: collapse to single-organization self-hosted
-- ============================================================================
-- Self-hosted build runs as one organization. Every domain table loses its
-- tenant_id column, the four tenant-root tables are dropped (or replaced by a
-- singleton settings row), helpers/triggers/RPCs are rewritten without tenant
-- arguments, and the 17 RLS policies become "any authenticated member of this
-- instance, with optional role gating".
--
-- Pre-flight assumptions (Phase 0–3 already shipped):
--   · super_admin role removed; tenant_role enum is ('admin','operator').
--   · BYOK / tenant_credentials inert at runtime; column-level access purely
--     internal at this point.
--   · White-label config columns already unused by the frontend.
--
-- Side-effects worth flagging:
--   · UNIQUE (tenant_id, *) constraints become UNIQUE (*) — phone/name/etc.
--     are now globally unique within the instance.
--   · ai_agent_config and the new app_settings are enforced as singletons.
--   · whatsapp-hub-logos bucket is dropped entirely (white-label gone).
--   · whatsapp-hub-knowledge bucket keeps the existing path convention; first
--     segment may still be a UUID but no longer needs to match a tenant_id.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Drop every RLS policy that referenced tenant_id / is_super_admin / etc.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS tenants_member_select               ON whatsapp_hub.tenants;
DROP POLICY IF EXISTS tenants_admin_write                 ON whatsapp_hub.tenants;
DROP POLICY IF EXISTS tenant_settings_member_select       ON whatsapp_hub.tenant_settings;
DROP POLICY IF EXISTS tenant_settings_admin_write         ON whatsapp_hub.tenant_settings;
DROP POLICY IF EXISTS tenant_credentials_admin_only       ON whatsapp_hub.tenant_credentials;
DROP POLICY IF EXISTS tenant_members_self_select          ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS tenant_members_tenant_select        ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS tenant_members_admin_write          ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS tenant_members_self_presence_update ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS contacts_tenant_all                 ON whatsapp_hub.contacts;
DROP POLICY IF EXISTS tags_tenant_all                     ON whatsapp_hub.tags;
DROP POLICY IF EXISTS contact_tags_tenant_all             ON whatsapp_hub.contact_tags;
DROP POLICY IF EXISTS templates_tenant_all                ON whatsapp_hub.templates;
DROP POLICY IF EXISTS campaigns_tenant_all                ON whatsapp_hub.campaigns;
DROP POLICY IF EXISTS campaign_contacts_tenant_all        ON whatsapp_hub.campaign_contacts;
DROP POLICY IF EXISTS follow_up_rules_tenant_all          ON whatsapp_hub.follow_up_rules;
DROP POLICY IF EXISTS conversations_tenant_all            ON whatsapp_hub.conversations;
DROP POLICY IF EXISTS messages_tenant_all                 ON whatsapp_hub.messages;
DROP POLICY IF EXISTS knowledge_base_tenant_all           ON whatsapp_hub.knowledge_base;
DROP POLICY IF EXISTS knowledge_chunks_tenant_all         ON whatsapp_hub.knowledge_chunks;
DROP POLICY IF EXISTS ai_agent_config_tenant_all          ON whatsapp_hub.ai_agent_config;
DROP POLICY IF EXISTS notifications_own                   ON whatsapp_hub.notifications;

DROP POLICY IF EXISTS wh_logos_public_read       ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_insert      ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_update      ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_delete      ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_tenant_read   ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_insert  ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_update  ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_delete  ON storage.objects;

-- ----------------------------------------------------------------------------
-- 2. Drop the auth trigger + notification triggers + RPCs that referenced
--    tenant_id (recreated below without tenancy).
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS whatsapp_hub.handle_new_user();

DROP TRIGGER  IF EXISTS on_inbound_notify ON whatsapp_hub.messages;
DROP TRIGGER  IF EXISTS on_handoff_notify ON whatsapp_hub.conversations;
DROP FUNCTION IF EXISTS whatsapp_hub._on_inbound_notify();
DROP FUNCTION IF EXISTS whatsapp_hub._on_handoff_notify();
DROP FUNCTION IF EXISTS whatsapp_hub._fanout_notification(
  UUID, whatsapp_hub.notification_type, UUID, UUID, TEXT, TEXT
);

DROP FUNCTION IF EXISTS whatsapp_hub.knowledge_search(UUID, vector, INT);

-- ----------------------------------------------------------------------------
-- 3. Drop FKs / UNIQUE constraints / columns referencing tenant_id on the
--    13 domain tables, plus matching composite indexes that named tenant_id.
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.contacts
  DROP CONSTRAINT IF EXISTS contacts_tenant_id_phone_key,
  DROP CONSTRAINT IF EXISTS contacts_tenant_id_fkey;
ALTER TABLE whatsapp_hub.contacts DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE whatsapp_hub.contacts
  ADD CONSTRAINT contacts_phone_key UNIQUE (phone);

ALTER TABLE whatsapp_hub.tags
  DROP CONSTRAINT IF EXISTS tags_tenant_id_name_key,
  DROP CONSTRAINT IF EXISTS tags_tenant_id_fkey;
ALTER TABLE whatsapp_hub.tags DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE whatsapp_hub.tags
  ADD CONSTRAINT tags_name_key UNIQUE (name);

ALTER TABLE whatsapp_hub.contact_tags
  DROP CONSTRAINT IF EXISTS contact_tags_tenant_id_fkey;
ALTER TABLE whatsapp_hub.contact_tags DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.templates
  DROP CONSTRAINT IF EXISTS templates_tenant_id_name_key,
  DROP CONSTRAINT IF EXISTS templates_tenant_id_fkey;
ALTER TABLE whatsapp_hub.templates DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE whatsapp_hub.templates
  ADD CONSTRAINT templates_name_key UNIQUE (name);

ALTER TABLE whatsapp_hub.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_tenant_id_fkey;
ALTER TABLE whatsapp_hub.campaigns DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.campaign_contacts
  DROP CONSTRAINT IF EXISTS campaign_contacts_tenant_id_fkey;
ALTER TABLE whatsapp_hub.campaign_contacts DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.follow_up_rules
  DROP CONSTRAINT IF EXISTS follow_up_rules_tenant_id_fkey;
ALTER TABLE whatsapp_hub.follow_up_rules DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.conversations
  DROP CONSTRAINT IF EXISTS conversations_tenant_id_contact_id_key,
  DROP CONSTRAINT IF EXISTS conversations_tenant_id_fkey;
ALTER TABLE whatsapp_hub.conversations DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE whatsapp_hub.conversations
  ADD CONSTRAINT conversations_contact_id_key UNIQUE (contact_id);

ALTER TABLE whatsapp_hub.messages
  DROP CONSTRAINT IF EXISTS messages_tenant_id_fkey;
ALTER TABLE whatsapp_hub.messages DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.knowledge_base
  DROP CONSTRAINT IF EXISTS knowledge_base_tenant_id_fkey;
ALTER TABLE whatsapp_hub.knowledge_base DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.knowledge_chunks
  DROP CONSTRAINT IF EXISTS knowledge_chunks_tenant_id_fkey;
ALTER TABLE whatsapp_hub.knowledge_chunks DROP COLUMN IF EXISTS tenant_id;

ALTER TABLE whatsapp_hub.ai_agent_config
  DROP CONSTRAINT IF EXISTS ai_agent_config_tenant_id_key,
  DROP CONSTRAINT IF EXISTS ai_agent_config_tenant_id_fkey;
ALTER TABLE whatsapp_hub.ai_agent_config DROP COLUMN IF EXISTS tenant_id;

-- Singleton: at most one ai_agent_config row.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_config_singleton
  ON whatsapp_hub.ai_agent_config ((true));

ALTER TABLE whatsapp_hub.notifications
  DROP CONSTRAINT IF EXISTS notifications_tenant_id_fkey;
ALTER TABLE whatsapp_hub.notifications DROP COLUMN IF EXISTS tenant_id;

-- ----------------------------------------------------------------------------
-- 4. Recreate practical indexes that previously included tenant_id.
--    (Dropping the column auto-removes any composite index that named it,
--    so we list them explicitly to keep the migration self-documenting.)
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS whatsapp_hub.idx_contacts_tenant_phone;
DROP INDEX IF EXISTS whatsapp_hub.idx_conversations_tenant_status;
DROP INDEX IF EXISTS whatsapp_hub.idx_campaign_contacts_pending;
DROP INDEX IF EXISTS whatsapp_hub.idx_messages_tenant_created;
DROP INDEX IF EXISTS whatsapp_hub.idx_conversations_assigned;
DROP INDEX IF EXISTS whatsapp_hub.idx_conversations_tenant_last_msg;
DROP INDEX IF EXISTS whatsapp_hub.idx_knowledge_chunks_tenant;
DROP INDEX IF EXISTS whatsapp_hub.idx_knowledge_base_tenant_status;
DROP INDEX IF EXISTS whatsapp_hub.idx_templates_tenant_status;
DROP INDEX IF EXISTS whatsapp_hub.idx_follow_up_rules_tenant_active;
DROP INDEX IF EXISTS whatsapp_hub.idx_contact_tags_tenant;
DROP INDEX IF EXISTS whatsapp_hub.idx_tenant_members_tenant_online;

CREATE INDEX IF NOT EXISTS idx_contacts_phone
  ON whatsapp_hub.contacts(phone);
CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON whatsapp_hub.conversations(status);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_pending
  ON whatsapp_hub.campaign_contacts(created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_messages_created
  ON whatsapp_hub.messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned
  ON whatsapp_hub.conversations(assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
  ON whatsapp_hub.conversations(last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_status
  ON whatsapp_hub.knowledge_base(status);
CREATE INDEX IF NOT EXISTS idx_templates_status
  ON whatsapp_hub.templates(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_rules_active
  ON whatsapp_hub.follow_up_rules(is_active)
  WHERE is_active = true;

-- ----------------------------------------------------------------------------
-- 5. Rename tenant_members → app_users; tighten UNIQUE constraint.
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.tenant_members
  DROP CONSTRAINT IF EXISTS tenant_members_tenant_id_user_id_key,
  DROP CONSTRAINT IF EXISTS tenant_members_tenant_id_fkey;
ALTER TABLE whatsapp_hub.tenant_members DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE whatsapp_hub.tenant_members
  ADD CONSTRAINT tenant_members_user_id_key UNIQUE (user_id);
ALTER TABLE whatsapp_hub.tenant_members RENAME TO app_users;

-- ----------------------------------------------------------------------------
-- 6. Drop tenant root tables.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS whatsapp_hub.tenant_credentials;
DROP TABLE IF EXISTS whatsapp_hub.tenant_settings;
DROP TABLE IF EXISTS whatsapp_hub.tenants CASCADE;

-- ----------------------------------------------------------------------------
-- 7. Singleton app_settings: holds business_hours, out_of_hours_message and
--    onboarding_completed. Replaces the per-tenant tenant_settings row.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.app_settings (
  id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_hours       JSONB NOT NULL DEFAULT '{}'::jsonb,
  out_of_hours_message TEXT,
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON whatsapp_hub.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON whatsapp_hub.app_settings
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

INSERT INTO whatsapp_hub.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE whatsapp_hub.app_settings ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 8. Drop SQL helpers that only made sense in the multi-tenant world.
--    current_user_role() stays — it's still the source of truth for role
--    gating in policies.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS whatsapp_hub.current_tenant_id();
DROP FUNCTION IF EXISTS whatsapp_hub.encrypt_secret(TEXT);
DROP FUNCTION IF EXISTS whatsapp_hub.decrypt_secret(TEXT);

-- ----------------------------------------------------------------------------
-- 9. handle_new_user trigger — single org, no tenant table to bootstrap.
--    The first signup on a fresh instance becomes the admin; every subsequent
--    self-serve signup defaults to operator. Invitations carry `invited_role`
--    in raw_user_meta_data which short-circuits the count-based decision.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  invited_role   TEXT;
  effective_role whatsapp_hub.tenant_role;
  v_count        INT;
BEGIN
  invited_role := NEW.raw_user_meta_data->>'invited_role';

  IF invited_role IN ('admin', 'operator') THEN
    effective_role := invited_role::whatsapp_hub.tenant_role;
  ELSE
    SELECT count(*) INTO v_count FROM whatsapp_hub.app_users;
    IF v_count = 0 THEN
      effective_role := 'admin';
    ELSE
      effective_role := 'operator';
    END IF;
  END IF;

  INSERT INTO whatsapp_hub.app_users (user_id, role, accepted_at)
  VALUES (NEW.id, effective_role, now())
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('role', effective_role::text)
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.handle_new_user() FROM PUBLIC, authenticated, anon;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.handle_new_user();

-- ----------------------------------------------------------------------------
-- 10. Notification fanout + triggers, no tenant scoping.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub._fanout_notification(
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
    user_id, type, conversation_id, message_id, title, body
  )
  SELECT
    u.user_id,
    p_type,
    p_conversation_id,
    p_message_id,
    p_title,
    p_body
  FROM whatsapp_hub.app_users u
  WHERE u.role IN ('admin', 'operator');
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
    'new_message'::whatsapp_hub.notification_type,
    NEW.conversation_id,
    NEW.id,
    title_txt,
    body_txt
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_inbound_notify
  AFTER INSERT ON whatsapp_hub.messages
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_inbound_notify();

CREATE OR REPLACE FUNCTION whatsapp_hub._on_handoff_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
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

  PERFORM whatsapp_hub._fanout_notification(
    'handoff'::whatsapp_hub.notification_type,
    NEW.id,
    NULL,
    'Handoff para humano: ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato'),
    'A IA foi pausada nessa conversa. Ela precisa de um atendente humano.'
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_handoff_notify
  AFTER UPDATE ON whatsapp_hub.conversations
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._on_handoff_notify();

-- ----------------------------------------------------------------------------
-- 11. knowledge_search RPC — drop the tenant arg; embedding-only similarity.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.knowledge_search(
  p_query_embedding vector(1536),
  p_top_k           INT DEFAULT 5
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
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.knowledge_base_id,
    kc.content,
    (1 - (kc.embedding <=> p_query_embedding))::real AS similarity
  FROM whatsapp_hub.knowledge_chunks kc
  WHERE kc.embedding IS NOT NULL
  ORDER BY kc.embedding <=> p_query_embedding
  LIMIT GREATEST(1, LEAST(p_top_k, 50));
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(vector, INT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(vector, INT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. Storage: drop the white-label logos bucket entirely; rewrite the
--     knowledge bucket policies to remove tenant_id-prefix path matching.
-- ----------------------------------------------------------------------------

-- Postgres 17 / Supabase Storage adicionou o trigger `storage.protect_delete`
-- que bloqueia DELETE direto em storage.objects / storage.buckets. Limpar o
-- bucket legado de logos exige desabilitar esse trigger — o que requer ser
-- DONO de storage.objects. Via Management API rodamos como `postgres`, que
-- gerencia POLICIES mas NÃO é dono da tabela, então o DISABLE TRIGGER falha
-- com insufficient_privilege (42501). A limpeza é best-effort: se não der pra
-- fazer, pulamos — o bucket órfão vazio é inócuo e não é usado pelo app OSS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whatsapp-hub-logos') THEN
    BEGIN
      ALTER TABLE storage.objects DISABLE TRIGGER protect_delete;
      ALTER TABLE storage.buckets DISABLE TRIGGER protect_delete;
      DELETE FROM storage.objects WHERE bucket_id = 'whatsapp-hub-logos';
      DELETE FROM storage.buckets  WHERE id        = 'whatsapp-hub-logos';
      ALTER TABLE storage.objects ENABLE TRIGGER protect_delete;
      ALTER TABLE storage.buckets ENABLE TRIGGER protect_delete;
    EXCEPTION
      WHEN undefined_object THEN
        -- Storage antigo, sem protect_delete: DELETE direto funciona.
        DELETE FROM storage.objects WHERE bucket_id = 'whatsapp-hub-logos';
        DELETE FROM storage.buckets  WHERE id        = 'whatsapp-hub-logos';
      WHEN insufficient_privilege THEN
        -- postgres não é dono de storage.objects: pula a limpeza legada.
        RAISE NOTICE 'Sem ownership de storage.objects; pulando limpeza do bucket legado whatsapp-hub-logos.';
    END;
  END IF;
END;
$$;

CREATE POLICY wh_knowledge_read
  ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'whatsapp-hub-knowledge');

CREATE POLICY wh_knowledge_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_knowledge_admin_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_knowledge_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND whatsapp_hub.current_user_role() = 'admin'
  );

-- ----------------------------------------------------------------------------
-- 13. Recreate the 17 RLS policies for the new shape.
--     Read access is open to any authenticated member; write/delete keeps a
--     role gate (operators can author day-to-day data; admin owns destructive
--     ops on the assets that touch Meta).
-- ----------------------------------------------------------------------------

-- app_settings (singleton): everyone reads, only admin writes.
CREATE POLICY app_settings_member_select
  ON whatsapp_hub.app_settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY app_settings_admin_write
  ON whatsapp_hub.app_settings
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- app_users: each user sees themselves; admin sees + manages everyone; any
-- user may update their own presence row (is_online / last_seen_at).
CREATE POLICY app_users_self_select
  ON whatsapp_hub.app_users
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY app_users_admin_write
  ON whatsapp_hub.app_users
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY app_users_self_presence_update
  ON whatsapp_hub.app_users
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Domain tables: any authenticated member may read; operators+admins may write.
-- DELETE is admin-only on assets that have downstream Meta side-effects.

CREATE POLICY contacts_select ON whatsapp_hub.contacts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY contacts_write  ON whatsapp_hub.contacts
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

CREATE POLICY tags_select ON whatsapp_hub.tags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY tags_write  ON whatsapp_hub.tags
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

CREATE POLICY contact_tags_select ON whatsapp_hub.contact_tags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY contact_tags_write  ON whatsapp_hub.contact_tags
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

-- templates: only admin may create/submit/delete (Meta lifecycle).
CREATE POLICY templates_select ON whatsapp_hub.templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY templates_admin_write ON whatsapp_hub.templates
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- campaigns: admin only for write/delete (mass dispatch).
CREATE POLICY campaigns_select ON whatsapp_hub.campaigns
  FOR SELECT TO authenticated USING (true);
CREATE POLICY campaigns_admin_write ON whatsapp_hub.campaigns
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- campaign_contacts: admin manages the queue directly; service_role does the
-- per-tick writes via Edge Functions, bypassing RLS.
CREATE POLICY campaign_contacts_select ON whatsapp_hub.campaign_contacts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY campaign_contacts_admin_write ON whatsapp_hub.campaign_contacts
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY follow_up_rules_select ON whatsapp_hub.follow_up_rules
  FOR SELECT TO authenticated USING (true);
CREATE POLICY follow_up_rules_admin_write ON whatsapp_hub.follow_up_rules
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- conversations + messages: operators do the day-to-day; the trigger pipeline
-- (service_role) handles the inbound side regardless of RLS.
CREATE POLICY conversations_select ON whatsapp_hub.conversations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY conversations_write ON whatsapp_hub.conversations
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

CREATE POLICY messages_select ON whatsapp_hub.messages
  FOR SELECT TO authenticated USING (true);
CREATE POLICY messages_write ON whatsapp_hub.messages
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

-- knowledge: admin controls the corpus (uploads, indexing).
CREATE POLICY knowledge_base_select ON whatsapp_hub.knowledge_base
  FOR SELECT TO authenticated USING (true);
CREATE POLICY knowledge_base_admin_write ON whatsapp_hub.knowledge_base
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY knowledge_chunks_select ON whatsapp_hub.knowledge_chunks
  FOR SELECT TO authenticated USING (true);
CREATE POLICY knowledge_chunks_admin_write ON whatsapp_hub.knowledge_chunks
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- ai_agent_config singleton: admin-only.
CREATE POLICY ai_agent_config_admin_all ON whatsapp_hub.ai_agent_config
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- notifications: per-user (any role).
CREATE POLICY notifications_self ON whatsapp_hub.notifications
  FOR ALL TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
