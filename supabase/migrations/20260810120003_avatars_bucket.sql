-- ============================================================================
-- Bucket público de avatares de membros: whatsapp-hub-avatars
-- ----------------------------------------------------------------------------
-- Path convention: <org_id>/<user_id>.<ext>. Cada membro gerencia apenas o
-- próprio arquivo, dentro da própria org. Leitura pública (avatar aparece no
-- inbox/equipe sem signed URL).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-hub-avatars', 'whatsapp-hub-avatars', true, 2 * 1024 * 1024,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS wh_avatars_read        ON storage.objects;
DROP POLICY IF EXISTS wh_avatars_self_insert ON storage.objects;
DROP POLICY IF EXISTS wh_avatars_self_update ON storage.objects;
DROP POLICY IF EXISTS wh_avatars_self_delete ON storage.objects;

CREATE POLICY wh_avatars_read
  ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'whatsapp-hub-avatars');

-- Só o próprio membro escreve, e só no path da própria org com o próprio id.
CREATE POLICY wh_avatars_self_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-avatars'
    AND whatsapp_hub.current_org_active()
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND storage.filename(name) LIKE auth.uid()::text || '.%'
  );

CREATE POLICY wh_avatars_self_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-avatars'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND storage.filename(name) LIKE auth.uid()::text || '.%'
  )
  WITH CHECK (
    bucket_id = 'whatsapp-hub-avatars'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND storage.filename(name) LIKE auth.uid()::text || '.%'
  );

CREATE POLICY wh_avatars_self_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-avatars'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND storage.filename(name) LIKE auth.uid()::text || '.%'
  );
