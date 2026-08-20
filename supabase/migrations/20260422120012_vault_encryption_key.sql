-- ============================================================================
-- Module 1 · Pivot encryption key from GUC to Supabase Vault
-- ============================================================================
-- Original design read the key from `app.whatsapp_hub_encryption_key` via
-- `current_setting()`. Supabase-managed Postgres does not permit custom GUCs
-- to be set (permission denied on ALTER DATABASE), so we store the key in
-- Supabase Vault — the platform's native secrets store — and read it through
-- `vault.decrypted_secrets`.
--
-- encrypt_secret() / decrypt_secret() are replaced to call a new helper
-- `whatsapp_hub._encryption_key()`, which is the ONLY place that touches the
-- vault and stays scoped to service_role.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Store the master key in Vault (idempotent — skip if already present).
-- The plaintext is injected by the deploy script and is never logged.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  existing uuid;
BEGIN
  SELECT id INTO existing FROM vault.secrets WHERE name = 'whatsapp_hub_encryption_key';
  IF existing IS NULL THEN
    PERFORM vault.create_secret(
      '__WHATSAPP_HUB_ENCRYPTION_KEY__',
      'whatsapp_hub_encryption_key',
      'Symmetric key used by whatsapp_hub.encrypt_secret / decrypt_secret'
    );
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- Internal key accessor. SECURITY DEFINER + search_path locked so the vault
-- lookup cannot be hijacked by a search-path attack. Callable only by
-- service_role.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._encryption_key()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
DECLARE
  k TEXT;
BEGIN
  SELECT decrypted_secret INTO k
    FROM vault.decrypted_secrets
   WHERE name = 'whatsapp_hub_encryption_key';
  IF k IS NULL OR length(k) < 16 THEN
    RAISE EXCEPTION 'vault secret whatsapp_hub_encryption_key is missing or too short';
  END IF;
  RETURN k;
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub._encryption_key() FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._encryption_key() TO service_role;

-- ----------------------------------------------------------------------------
-- Rebind encrypt_secret / decrypt_secret to the new accessor.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.encrypt_secret(plaintext TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF plaintext IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN encode(pgp_sym_encrypt(plaintext, whatsapp_hub._encryption_key()), 'base64');
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.decrypt_secret(ciphertext TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF ciphertext IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN pgp_sym_decrypt(decode(ciphertext, 'base64'), whatsapp_hub._encryption_key());
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.encrypt_secret(TEXT) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.decrypt_secret(TEXT) FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.encrypt_secret(TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.decrypt_secret(TEXT) TO service_role;
