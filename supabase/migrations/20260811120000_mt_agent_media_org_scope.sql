-- ============================================================================
-- 20260811120000_mt_agent_media_org_scope
-- ----------------------------------------------------------------------------
-- Multi-tenancy · correção: o bucket whatsapp-hub-agent-media foi criado antes
-- da migração multi-tenant (20260624) e ficou de fora do rework de storage do
-- mt_policies (20260810120002), que org-escopou knowledge e criou avatars. Como
-- resultado, a policy de escrita só checava role='admin' — sem isolamento por
-- org — e os uploads iam para a raiz do bucket (`<uuid>.<ext>`), sem prefixo da
-- org. Aqui alinhamos o bucket ao mesmo padrão dos demais:
--
--     path = <org_id>/<uuid>.<ext>
--
-- Leitura continua PÚBLICA (o Zernio baixa a mídia pela URL pública ao enviar);
-- apenas INSERT/DELETE passam a exigir o prefixo da org + role admin da org.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

DROP POLICY IF EXISTS wh_agent_media_read         ON storage.objects;
DROP POLICY IF EXISTS wh_agent_media_admin_insert ON storage.objects;
DROP POLICY IF EXISTS wh_agent_media_admin_delete ON storage.objects;

-- Leitura pública (bucket público; a URL é usada pelo Zernio para baixar).
CREATE POLICY wh_agent_media_read
  ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'whatsapp-hub-agent-media');

-- Upload apenas por admin da org, e só no path da própria org.
CREATE POLICY wh_agent_media_org_admin_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-agent-media'
    AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
  );

-- Remoção apenas por admin da org, restrita ao path da própria org.
CREATE POLICY wh_agent_media_org_admin_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-agent-media'
    AND whatsapp_hub.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
  );
