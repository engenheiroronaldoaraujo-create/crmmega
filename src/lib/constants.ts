// Schema used by every application query (see CLAUDE.md → Arquitetura Multi-Schema).
export const APP_SCHEMA = 'whatsapp_hub' as const;

// localStorage keys owned by Bootstrap Setup (CLAUDE.md → Funcionalidade 0).
export const STORAGE_KEYS = {
  supabaseUrl: 'supabase_url',
  supabaseAnonKey: 'supabase_anon_key',
} as const;
