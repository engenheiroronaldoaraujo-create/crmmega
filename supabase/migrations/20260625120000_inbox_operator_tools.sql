-- ============================================================================
-- 20260625120000_inbox_operator_tools
-- ----------------------------------------------------------------------------
-- Recursos do operador no inbox:
--   1. conversations.pinned_note — nota fixa visível no topo da conversa.
--   2. RPC list_operators() — lista operadores (user_id, email, role) para o
--      seletor de atribuição (auth.users não é exposto via PostgREST).
-- (Atribuição usa conversations.assigned_to, que já existe. Tags reusam
--  contact_tags; campos personalizados reusam contacts.custom_fields.)
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS pinned_note TEXT;

CREATE OR REPLACE FUNCTION whatsapp_hub.list_operators()
RETURNS TABLE (user_id uuid, email text, role whatsapp_hub.tenant_role)
LANGUAGE sql
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, public, pg_temp
AS $$
  SELECT au.user_id, u.email::text, au.role
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
   ORDER BY au.role, u.email;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_operators() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_operators() TO authenticated, service_role;
