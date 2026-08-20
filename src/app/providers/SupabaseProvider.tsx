import {
  createContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  clearSupabaseCredentials,
  getSupabaseCredentials,
  isSupabaseConfigured,
  setSupabaseCredentials,
  type SupabaseCredentials,
} from '@/lib/supabase';

// ----------------------------------------------------------------------------
// SupabaseProvider
// ----------------------------------------------------------------------------
// Single source of truth for whether the app is bootstrapped. All children can
// ask `configured` and react accordingly (the router uses it to gate routes).
// Writes flow through `saveCredentials` / `clearCredentials` so the internal
// cached client is reset in lockstep with localStorage.
// ----------------------------------------------------------------------------

interface SupabaseContextValue {
  configured: boolean;
  credentials: SupabaseCredentials | null;
  saveCredentials: (creds: SupabaseCredentials) => void;
  clearCredentials: () => void;
}

export const SupabaseContext = createContext<SupabaseContextValue | null>(null);

export function SupabaseProvider({ children }: { children: ReactNode }) {
  const [configured, setConfigured] = useState(() => isSupabaseConfigured());
  const [credentials, setCredentials] = useState<SupabaseCredentials | null>(
    () => getSupabaseCredentials(),
  );

  const saveCredentials = useCallback((creds: SupabaseCredentials) => {
    setSupabaseCredentials(creds);
    setCredentials(creds);
    setConfigured(true);
  }, []);

  const clearCredentials = useCallback(() => {
    clearSupabaseCredentials();
    setCredentials(null);
    setConfigured(false);
  }, []);

  const value = useMemo<SupabaseContextValue>(
    () => ({ configured, credentials, saveCredentials, clearCredentials }),
    [configured, credentials, saveCredentials, clearCredentials],
  );

  return (
    <SupabaseContext.Provider value={value}>{children}</SupabaseContext.Provider>
  );
}
