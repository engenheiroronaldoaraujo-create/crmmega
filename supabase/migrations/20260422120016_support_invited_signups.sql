-- ============================================================================
-- Module 4 · Let on_auth_user_created handle invited signups correctly
-- ============================================================================
-- When Module 3 added the self-serve trigger, it always created a brand-new
-- tenant for every signup. Onboarding Step 6 needs a different path: admins
-- invite team members by email, so those signups should be attached to the
-- inviter's tenant instead of spinning up a new one.
--
-- The `admin.inviteUserByEmail(email, { data: { … } })` SDK call writes the
-- supplied object into `raw_user_meta_data`. We mark invites by setting
-- `invited_to_tenant` (UUID) and `invited_role`; the trigger branches on
-- those keys.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  invited_tenant UUID;
  invited_role   TEXT;
  new_tenant_id  UUID;
  tenant_slug    TEXT;
  tenant_name    TEXT;
BEGIN
  invited_tenant := NULLIF(NEW.raw_user_meta_data->>'invited_to_tenant', '')::uuid;
  invited_role   := NEW.raw_user_meta_data->>'invited_role';

  IF invited_tenant IS NOT NULL
     AND invited_role IN ('admin', 'operator', 'viewer') THEN
    -- Invited: link to the inviter's tenant, do NOT create a new one.
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

  -- Self-serve: create tenant + settings + member, then write app_metadata.
  tenant_name := COALESCE(split_part(NEW.email, '@', 1), 'Tenant');
  tenant_slug := 't-' || substring(replace(NEW.id::text, '-', '') from 1 for 12);

  INSERT INTO whatsapp_hub.tenants (name, slug)
  VALUES (tenant_name, tenant_slug)
  RETURNING id INTO new_tenant_id;

  INSERT INTO whatsapp_hub.tenant_settings (tenant_id)
  VALUES (new_tenant_id);

  INSERT INTO whatsapp_hub.tenant_members (tenant_id, user_id, role, accepted_at)
  VALUES (new_tenant_id, NEW.id, 'admin', now());

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object(
                                'tenant_id', new_tenant_id::text,
                                'role',      'admin'
                              )
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;
