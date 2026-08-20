-- ============================================================================
-- Module 3 · Auth bootstrap: create a tenant for every new signup (self-serve)
-- ============================================================================
-- Trigger that fires after a row is inserted into auth.users. It provisions:
--   · tenants row
--   · tenant_settings row (defaults)
--   · tenant_members row linking the user as admin
--   · app_metadata.tenant_id and app_metadata.role on the user
--
-- The app_metadata write is what makes RLS work: `whatsapp_hub.current_tenant_id()`
-- reads from auth.jwt() -> 'app_metadata'. After signup the client must call
-- `supabase.auth.refreshSession()` so the next access token carries these claims.
--
-- This is the Option A "self-serve" flow. Future modules can replace this with
-- an invite-only path by disabling the trigger for non-admin-invited users.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  new_tenant_id UUID;
  tenant_slug   TEXT;
  tenant_name   TEXT;
BEGIN
  -- Tenant name defaults to the email local-part; slug is a short random.
  tenant_name := COALESCE(split_part(NEW.email, '@', 1), 'Tenant');
  tenant_slug := 't-' || substring(replace(NEW.id::text, '-', '') from 1 for 12);

  INSERT INTO whatsapp_hub.tenants (name, slug)
  VALUES (tenant_name, tenant_slug)
  RETURNING id INTO new_tenant_id;

  INSERT INTO whatsapp_hub.tenant_settings (tenant_id)
  VALUES (new_tenant_id);

  INSERT INTO whatsapp_hub.tenant_members (tenant_id, user_id, role, accepted_at)
  VALUES (new_tenant_id, NEW.id, 'admin', now());

  -- Merge tenant_id + role into app_metadata without dropping existing keys.
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

-- Restrict who can execute this function even though the trigger invokes it
-- with definer rights (the trigger call-site is privileged regardless).
REVOKE EXECUTE ON FUNCTION whatsapp_hub.handle_new_user() FROM PUBLIC, authenticated, anon;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub.handle_new_user();
