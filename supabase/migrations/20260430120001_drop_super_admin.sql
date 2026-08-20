-- ============================================================================
-- Phase 3 · Flatten roles: drop super_admin, collapse enum to (admin, operator)
-- ============================================================================
-- Self-hosted build runs as a single organization. The Agentise master role
-- (super_admin) and the legacy `viewer` tier no longer apply:
--
--   · is_super_admin() helper is dropped; every policy that branched on it is
--     rewritten without that disjunction.
--   · tenant_role enum becomes ('admin', 'operator'); existing 'viewer' rows
--     are migrated to 'operator' before the type swap.
--   · handle_new_user provisions the very first signup as the admin of a
--     fresh tenant; subsequent self-serve signups land as operator on that
--     same tenant. Invited signups (invite-team-member) keep flowing through
--     raw_user_meta_data.invited_to_tenant + invited_role.
--
-- Migrations 10, 17 and 23 stay intact in history; this migration drops their
-- policies and recreates them without the super_admin escape hatch.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Drop policies that depend on is_super_admin()
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS tenants_member_select              ON whatsapp_hub.tenants;
DROP POLICY IF EXISTS tenants_super_admin_write          ON whatsapp_hub.tenants;
DROP POLICY IF EXISTS tenant_settings_member_select      ON whatsapp_hub.tenant_settings;
DROP POLICY IF EXISTS tenant_settings_admin_write        ON whatsapp_hub.tenant_settings;
DROP POLICY IF EXISTS tenant_credentials_admin_only      ON whatsapp_hub.tenant_credentials;
DROP POLICY IF EXISTS tenant_members_tenant_select       ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS tenant_members_admin_write         ON whatsapp_hub.tenant_members;
DROP POLICY IF EXISTS contacts_tenant_all                ON whatsapp_hub.contacts;
DROP POLICY IF EXISTS tags_tenant_all                    ON whatsapp_hub.tags;
DROP POLICY IF EXISTS contact_tags_tenant_all            ON whatsapp_hub.contact_tags;
DROP POLICY IF EXISTS templates_tenant_all               ON whatsapp_hub.templates;
DROP POLICY IF EXISTS campaigns_tenant_all               ON whatsapp_hub.campaigns;
DROP POLICY IF EXISTS campaign_contacts_tenant_all       ON whatsapp_hub.campaign_contacts;
DROP POLICY IF EXISTS follow_up_rules_tenant_all         ON whatsapp_hub.follow_up_rules;
DROP POLICY IF EXISTS conversations_tenant_all           ON whatsapp_hub.conversations;
DROP POLICY IF EXISTS messages_tenant_all                ON whatsapp_hub.messages;
DROP POLICY IF EXISTS knowledge_base_tenant_all          ON whatsapp_hub.knowledge_base;
DROP POLICY IF EXISTS knowledge_chunks_tenant_all        ON whatsapp_hub.knowledge_chunks;
DROP POLICY IF EXISTS ai_agent_config_tenant_all         ON whatsapp_hub.ai_agent_config;
DROP POLICY IF EXISTS notifications_own                  ON whatsapp_hub.notifications;

DROP POLICY IF EXISTS wh_logos_admin_insert              ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_update              ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_delete              ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_tenant_read           ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_insert          ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_update          ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_delete          ON storage.objects;

-- ----------------------------------------------------------------------------
-- 2. Drop the helper function
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS whatsapp_hub.is_super_admin();

-- ----------------------------------------------------------------------------
-- 3. Collapse tenant_role enum to ('admin','operator')
-- ----------------------------------------------------------------------------
-- Postgres can't drop a value from an enum in place, so we rename the old
-- type, create the new one, repoint columns, and drop the old type. Existing
-- 'viewer' rows are pre-mapped to 'operator' before the cast.

UPDATE whatsapp_hub.tenant_members
   SET role = 'operator'
 WHERE role = 'viewer';

ALTER TYPE whatsapp_hub.tenant_role RENAME TO tenant_role_legacy;

CREATE TYPE whatsapp_hub.tenant_role AS ENUM ('admin', 'operator');

ALTER TABLE whatsapp_hub.tenant_members
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE whatsapp_hub.tenant_role
    USING role::text::whatsapp_hub.tenant_role,
  ALTER COLUMN role SET DEFAULT 'operator'::whatsapp_hub.tenant_role;

DROP TYPE whatsapp_hub.tenant_role_legacy;

-- ----------------------------------------------------------------------------
-- 4. Migrate any stale app_metadata roles (super_admin / viewer → admin / operator)
-- ----------------------------------------------------------------------------
-- Defensive: if an instance is being migrated rather than installed fresh,
-- legacy values must not survive in the JWT claims.

UPDATE auth.users
   SET raw_app_meta_data = raw_app_meta_data
                          || jsonb_build_object('role', 'admin')
 WHERE raw_app_meta_data ->> 'role' = 'super_admin';

UPDATE auth.users
   SET raw_app_meta_data = raw_app_meta_data
                          || jsonb_build_object('role', 'operator')
 WHERE raw_app_meta_data ->> 'role' = 'viewer';

-- ----------------------------------------------------------------------------
-- 5. Recreate table policies without is_super_admin()
-- ----------------------------------------------------------------------------

CREATE POLICY tenants_member_select
  ON whatsapp_hub.tenants
  FOR SELECT TO authenticated
  USING (id = whatsapp_hub.current_tenant_id());

CREATE POLICY tenants_admin_write
  ON whatsapp_hub.tenants
  FOR ALL TO authenticated
  USING (
    id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY tenant_settings_member_select
  ON whatsapp_hub.tenant_settings
  FOR SELECT TO authenticated
  USING (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY tenant_settings_admin_write
  ON whatsapp_hub.tenant_settings
  FOR ALL TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY tenant_credentials_admin_only
  ON whatsapp_hub.tenant_credentials
  FOR ALL TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY tenant_members_tenant_select
  ON whatsapp_hub.tenant_members
  FOR SELECT TO authenticated
  USING (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY tenant_members_admin_write
  ON whatsapp_hub.tenant_members
  FOR ALL TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY contacts_tenant_all ON whatsapp_hub.contacts
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY tags_tenant_all ON whatsapp_hub.tags
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY contact_tags_tenant_all ON whatsapp_hub.contact_tags
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY templates_tenant_all ON whatsapp_hub.templates
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY campaigns_tenant_all ON whatsapp_hub.campaigns
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY campaign_contacts_tenant_all ON whatsapp_hub.campaign_contacts
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY follow_up_rules_tenant_all ON whatsapp_hub.follow_up_rules
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY conversations_tenant_all ON whatsapp_hub.conversations
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY messages_tenant_all ON whatsapp_hub.messages
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY knowledge_base_tenant_all ON whatsapp_hub.knowledge_base
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY knowledge_chunks_tenant_all ON whatsapp_hub.knowledge_chunks
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY ai_agent_config_tenant_all ON whatsapp_hub.ai_agent_config
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id());

CREATE POLICY notifications_own
  ON whatsapp_hub.notifications
  FOR ALL TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND user_id = auth.uid()
  )
  WITH CHECK (
    tenant_id = whatsapp_hub.current_tenant_id()
    AND user_id = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- 6. Recreate storage policies without is_super_admin()
-- ----------------------------------------------------------------------------

CREATE POLICY wh_logos_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-logos'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_logos_admin_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-logos'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-logos'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_logos_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-logos'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_knowledge_tenant_read
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
  );

CREATE POLICY wh_knowledge_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_knowledge_admin_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_knowledge_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );

-- ----------------------------------------------------------------------------
-- 7. handle_new_user — first signup becomes the instance admin
-- ----------------------------------------------------------------------------
-- Self-serve flow:
--   · If no tenant exists yet, this user creates it and becomes admin.
--   · Otherwise the user is attached to the existing tenant as operator
--     (single-org self-hosted invariant; further tenants are not created).
-- Invited flow (admin sends an invite via invite-team-member):
--   · raw_user_meta_data.invited_to_tenant carries the target tenant.
--   · raw_user_meta_data.invited_role carries 'admin' or 'operator'.
--
-- Phase 4 will collapse tenants entirely; this function becomes simpler then.

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  invited_tenant UUID;
  invited_role   TEXT;
  target_tenant  UUID;
  tenant_slug    TEXT;
  tenant_name    TEXT;
  effective_role whatsapp_hub.tenant_role;
BEGIN
  invited_tenant := NULLIF(NEW.raw_user_meta_data->>'invited_to_tenant', '')::uuid;
  invited_role   := NEW.raw_user_meta_data->>'invited_role';

  IF invited_tenant IS NOT NULL
     AND invited_role IN ('admin', 'operator') THEN
    -- Invited path: link to the inviter's tenant.
    INSERT INTO whatsapp_hub.tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (invited_tenant, NEW.id, invited_role::whatsapp_hub.tenant_role, now())
    ON CONFLICT (tenant_id, user_id) DO NOTHING;

    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object(
                                  'tenant_id', invited_tenant::text,
                                  'role',      invited_role
                                )
     WHERE id = NEW.id;

    RETURN NEW;
  END IF;

  -- Self-serve path: pick the existing tenant if any, otherwise create one.
  SELECT id INTO target_tenant
    FROM whatsapp_hub.tenants
   ORDER BY created_at ASC
   LIMIT 1;

  IF target_tenant IS NULL THEN
    tenant_name := COALESCE(split_part(NEW.email, '@', 1), 'WhatsApp Hub');
    tenant_slug := 't-' || substring(replace(NEW.id::text, '-', '') from 1 for 12);

    INSERT INTO whatsapp_hub.tenants (name, slug)
    VALUES (tenant_name, tenant_slug)
    RETURNING id INTO target_tenant;

    INSERT INTO whatsapp_hub.tenant_settings (tenant_id)
    VALUES (target_tenant);

    effective_role := 'admin';
  ELSE
    effective_role := 'operator';
  END IF;

  INSERT INTO whatsapp_hub.tenant_members (tenant_id, user_id, role, accepted_at)
  VALUES (target_tenant, NEW.id, effective_role, now())
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'tenant_id', target_tenant::text,
                                'role',      effective_role::text
                              )
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.handle_new_user() FROM PUBLIC, authenticated, anon;
