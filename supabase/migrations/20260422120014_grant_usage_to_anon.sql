-- ============================================================================
-- Module 1 · Fix: grant schema USAGE to anon
-- ============================================================================
-- PostgREST exposes a table to an unauthenticated caller only if:
--   1. The schema itself has USAGE granted to the caller's role (anon)
--   2. Table-level privileges are sufficient (normally superseded by RLS)
--
-- Migration 1 granted USAGE to `authenticated` and `service_role` only, so
-- anonymous pings (such as the frontend's Bootstrap Setup "Testar Conexão")
-- got "permission denied for schema whatsapp_hub" before any RLS policy ran.
--
-- Granting USAGE to anon does NOT expose data — RLS on every table still
-- denies anonymous access. USAGE alone only lets PostgREST acknowledge the
-- schema exists, which is exactly what we need for connectivity probes.
-- ============================================================================

GRANT USAGE ON SCHEMA whatsapp_hub TO anon;
