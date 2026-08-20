-- ============================================================================
-- Module 1 · Fix: qualify pgcrypto functions explicitly
-- ============================================================================
-- On Supabase, pgcrypto lives in schema `extensions`, not `public`. Our
-- encrypt_secret/decrypt_secret functions set `search_path = public, pg_temp`
-- which excludes `extensions`, so `pgp_sym_encrypt` is not resolvable.
-- Fix: qualify the calls as `extensions.pgp_sym_encrypt` / `extensions.pgp_sym_decrypt`.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

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
  RETURN encode(extensions.pgp_sym_encrypt(plaintext, whatsapp_hub._encryption_key()), 'base64');
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
  RETURN extensions.pgp_sym_decrypt(decode(ciphertext, 'base64'), whatsapp_hub._encryption_key());
END;
$$;
