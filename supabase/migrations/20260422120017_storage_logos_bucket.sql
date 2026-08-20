-- ============================================================================
-- Module 4 · Storage bucket: whatsapp-hub-logos (public read, tenant-scoped write)
-- ============================================================================
-- Holds per-tenant logos and favicons. Path convention is:
--
--     <tenant_id>/logo.<ext>
--     <tenant_id>/favicon.<ext>
--
-- Read is public because white-label deployments need to serve these over any
-- CNAME without auth. Write/update/delete are restricted to admins of the
-- owning tenant: the first path segment (tenant_id) must match the caller's
-- app_metadata.tenant_id.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-hub-logos',
  'whatsapp-hub-logos',
  true,
  2 * 1024 * 1024,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Drop existing policies on storage.objects for this bucket (idempotent re-run)
DROP POLICY IF EXISTS wh_logos_public_read      ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_insert     ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_update     ON storage.objects;
DROP POLICY IF EXISTS wh_logos_admin_delete     ON storage.objects;

-- Anyone (including anon) may read — bucket is public anyway, but RLS still
-- applies to presigned URL generation and listing.
CREATE POLICY wh_logos_public_read
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'whatsapp-hub-logos');

-- Write policies: first path segment must equal caller's tenant_id AND role
-- must be admin (or super_admin).
CREATE POLICY wh_logos_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-logos'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY wh_logos_admin_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-logos'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-logos'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY wh_logos_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-logos'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );
