-- ============================================================================
-- Module 11 · Storage bucket: whatsapp-hub-knowledge
-- ============================================================================
-- PDFs and other source docs get uploaded here by admins. Path convention
-- mirrors the logos bucket (first segment = tenant_id) so the same RLS
-- pattern works:
--
--     <tenant_id>/<generated_uuid>.pdf
--
-- Private bucket (no public URL). Edge Functions (service_role) download
-- the file to extract text, then the raw file stays for re-indexing.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-hub-knowledge',
  'whatsapp-hub-knowledge',
  false,
  30 * 1024 * 1024,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS wh_knowledge_tenant_read   ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_insert  ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_update  ON storage.objects;
DROP POLICY IF EXISTS wh_knowledge_admin_delete  ON storage.objects;

CREATE POLICY wh_knowledge_tenant_read
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      OR whatsapp_hub.is_super_admin()
    )
  );

CREATE POLICY wh_knowledge_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY wh_knowledge_admin_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );

CREATE POLICY wh_knowledge_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-knowledge'
    AND (
      (storage.foldername(name))[1] = whatsapp_hub.current_tenant_id()::text
      AND whatsapp_hub.current_user_role() = 'admin'
    )
    OR whatsapp_hub.is_super_admin()
  );
