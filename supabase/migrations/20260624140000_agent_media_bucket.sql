-- ============================================================================
-- 20260624140000_agent_media_bucket
-- ----------------------------------------------------------------------------
-- Bucket público para as mídias do agente. O usuário sobe o arquivo; geramos a
-- URL pública e a usamos como attachmentUrl no envio via Zernio (que precisa
-- baixar a mídia por uma URL pública). Admin escreve; leitura pública.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Caminho do arquivo no bucket (para conseguir removê-lo ao excluir a mídia).
ALTER TABLE whatsapp_hub.ai_agent_media
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- Bucket público, limite 25MB (mesmo teto de mídia do Zernio).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-hub-agent-media', 'whatsapp-hub-agent-media', true, 25 * 1024 * 1024)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS wh_agent_media_read         ON storage.objects;
DROP POLICY IF EXISTS wh_agent_media_admin_insert ON storage.objects;
DROP POLICY IF EXISTS wh_agent_media_admin_delete ON storage.objects;

-- Leitura pública (bucket público; a URL é usada pelo Zernio para baixar).
CREATE POLICY wh_agent_media_read
  ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'whatsapp-hub-agent-media');

-- Upload e remoção apenas por admin.
CREATE POLICY wh_agent_media_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-agent-media'
    AND whatsapp_hub.current_user_role() = 'admin'
  );

CREATE POLICY wh_agent_media_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-agent-media'
    AND whatsapp_hub.current_user_role() = 'admin'
  );
