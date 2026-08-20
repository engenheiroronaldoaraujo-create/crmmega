-- ============================================================================
-- Module 1 · Row-Level Security Policies
-- ============================================================================
-- Every table in whatsapp_hub has RLS enabled. The two primary checks are:
--
--   tenant_id = whatsapp_hub.current_tenant_id()   -- tenant isolation
--   whatsapp_hub.is_super_admin()                  -- Agentise master bypass
--
-- Edge Functions run with the service_role key, which bypasses RLS entirely
-- (Supabase default). So writes performed by webhook/dispatch/cron workers
-- are not constrained by these policies.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Enable RLS
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.tenant_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.tenant_credentials  ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.tenant_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.tags                ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.contact_tags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.templates           ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.campaign_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.follow_up_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.conversations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.knowledge_base      ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.knowledge_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ai_agent_config     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.notifications       ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------------
-- Tenant members may read only their own tenant row. Only super_admin writes.

CREATE POLICY tenants_member_select
  ON whatsapp_hub.tenants
  FOR SELECT TO authenticated
  USING (id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY tenants_super_admin_write
  ON whatsapp_hub.tenants
  FOR ALL TO authenticated
  USING (whatsapp_hub.is_super_admin())
  WITH CHECK (whatsapp_hub.is_super_admin());

-- ----------------------------------------------------------------------------
-- tenant_settings
-- ----------------------------------------------------------------------------
-- Any tenant member can read settings (needed for white-label branding).
-- Only tenant admins can update.

CREATE POLICY tenant_settings_member_select
  ON whatsapp_hub.tenant_settings
  FOR SELECT TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY tenant_settings_admin_write
  ON whatsapp_hub.tenant_settings
  FOR ALL TO authenticated
  USING (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  );

-- ----------------------------------------------------------------------------
-- tenant_credentials (admin only, extra tight)
-- ----------------------------------------------------------------------------
-- Even SELECT is blocked for non-admins because the encrypted blobs are
-- dangerous to leak even as ciphertext.

CREATE POLICY tenant_credentials_admin_only
  ON whatsapp_hub.tenant_credentials
  FOR ALL TO authenticated
  USING (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  );

-- ----------------------------------------------------------------------------
-- tenant_members
-- ----------------------------------------------------------------------------
-- Each user may SELECT their own membership (needed at login to resolve
-- which tenants they belong to). Admins manage the full member list.

CREATE POLICY tenant_members_self_select
  ON whatsapp_hub.tenant_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY tenant_members_tenant_select
  ON whatsapp_hub.tenant_members
  FOR SELECT TO authenticated
  USING (
    tenant_id = whatsapp_hub.current_tenant_id()
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY tenant_members_admin_write
  ON whatsapp_hub.tenant_members
  FOR ALL TO authenticated
  USING (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = whatsapp_hub.current_tenant_id()
      AND whatsapp_hub.current_user_role() = 'admin')
    OR whatsapp_hub.is_super_admin()
  );

-- Self-presence update: a member must be able to set their own is_online /
-- last_seen_at without being an admin.
CREATE POLICY tenant_members_self_presence_update
  ON whatsapp_hub.tenant_members
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Generic tenant-scoped tables
-- ----------------------------------------------------------------------------
-- Every authenticated member of the tenant can CRUD rows belonging to that
-- tenant. Finer-grained role checks (operator vs viewer) are enforced at the
-- application layer or via additional policies in later modules.

CREATE POLICY contacts_tenant_all ON whatsapp_hub.contacts
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY tags_tenant_all ON whatsapp_hub.tags
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY contact_tags_tenant_all ON whatsapp_hub.contact_tags
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY templates_tenant_all ON whatsapp_hub.templates
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY campaigns_tenant_all ON whatsapp_hub.campaigns
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY campaign_contacts_tenant_all ON whatsapp_hub.campaign_contacts
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY follow_up_rules_tenant_all ON whatsapp_hub.follow_up_rules
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY conversations_tenant_all ON whatsapp_hub.conversations
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY messages_tenant_all ON whatsapp_hub.messages
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY knowledge_base_tenant_all ON whatsapp_hub.knowledge_base
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY knowledge_chunks_tenant_all ON whatsapp_hub.knowledge_chunks
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

CREATE POLICY ai_agent_config_tenant_all ON whatsapp_hub.ai_agent_config
  FOR ALL TO authenticated
  USING      (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin())
  WITH CHECK (tenant_id = whatsapp_hub.current_tenant_id() OR whatsapp_hub.is_super_admin());

-- ----------------------------------------------------------------------------
-- notifications (per-user, within tenant)
-- ----------------------------------------------------------------------------

CREATE POLICY notifications_own
  ON whatsapp_hub.notifications
  FOR ALL TO authenticated
  USING (
    (tenant_id = whatsapp_hub.current_tenant_id() AND user_id = auth.uid())
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = whatsapp_hub.current_tenant_id() AND user_id = auth.uid())
    OR whatsapp_hub.is_super_admin()
  );
