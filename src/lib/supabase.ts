import { createClient } from '@supabase/supabase-js';
import { APP_SCHEMA, STORAGE_KEYS } from './constants';

// ----------------------------------------------------------------------------
// Dynamic Supabase client
// ----------------------------------------------------------------------------
// Core Supabase credentials are injected at build time after /api/bootstrap
// sets Vercel envs and triggers a redeploy. The localStorage fallback exists
// only for legacy development sessions.
//
// All queries default to the whatsapp_hub schema.
// ----------------------------------------------------------------------------

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

export function getSupabaseCredentials(): SupabaseCredentials | null {
  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (envUrl && envAnon) return { url: envUrl, anonKey: envAnon };
  if (typeof window === 'undefined') return null;
  const url = window.localStorage.getItem(STORAGE_KEYS.supabaseUrl);
  const anonKey = window.localStorage.getItem(STORAGE_KEYS.supabaseAnonKey);
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseCredentials() !== null;
}

function buildClient(creds: SupabaseCredentials) {
  return createClient(creds.url, creds.anonKey, {
    db: { schema: APP_SCHEMA },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export type AppSupabaseClient = ReturnType<typeof buildClient>;

let supabaseInstance: AppSupabaseClient | null = null;

/**
 * Returns the singleton Supabase client scoped to the `whatsapp_hub` schema.
 * Throws if credentials are not configured — callers downstream of
 * SupabaseProvider should never hit that path.
 */
export function getSupabase(): AppSupabaseClient {
  if (supabaseInstance) return supabaseInstance;
  const creds = getSupabaseCredentials();
  if (!creds) {
    throw new Error(
      'Supabase not configured. Reach /setup before consuming the client.',
    );
  }
  supabaseInstance = buildClient(creds);
  return supabaseInstance;
}

/**
 * Clears the cached client so the next getSupabase() rebuilds it with
 * fresh credentials. Called after Settings changes Supabase URL/key.
 */
export function resetSupabaseClient(): void {
  supabaseInstance = null;
}

/**
 * Legacy development fallback. Production setup writes Vercel envs instead.
 */
export function setSupabaseCredentials(creds: SupabaseCredentials): void {
  window.localStorage.setItem(STORAGE_KEYS.supabaseUrl, creds.url);
  window.localStorage.setItem(STORAGE_KEYS.supabaseAnonKey, creds.anonKey);
  resetSupabaseClient();
}

export function clearSupabaseCredentials(): void {
  window.localStorage.removeItem(STORAGE_KEYS.supabaseUrl);
  window.localStorage.removeItem(STORAGE_KEYS.supabaseAnonKey);
  resetSupabaseClient();
}

/**
 * Validates that the given URL + anon key belong to a live Supabase project.
 *
 * We intentionally hit `/auth/v1/settings` — a lightweight endpoint that only
 * requires a valid apikey — instead of querying `whatsapp_hub.tenants`. That
 * avoids granting the anonymous role access to application tables just so a
 * pre-login connectivity probe can resolve.
 *
 *  · 200 → URL reachable + apikey accepted
 *  · 401 → apikey rejected
 *  · 4xx/5xx → unreachable project / wrong URL / Auth not provisioned
 *  · thrown → network, DNS, CORS
 */
export async function testSupabaseConnection(
  creds: SupabaseCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const base = creds.url.replace(/\/$/, '');
    const res = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: creds.anonKey },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) {
      return { ok: false, error: 'Anon key rejeitada pelo Supabase (401).' };
    }
    return {
      ok: false,
      error: `Supabase respondeu ${res.status} ${res.statusText || ''}`.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : 'Erro de rede ao contactar o Supabase',
    };
  }
}
