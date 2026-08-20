import { useContext } from 'react';
import { SupabaseContext } from '@/app/providers/SupabaseProvider';

export function useSupabaseConfig() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) {
    throw new Error('useSupabaseConfig must be used inside <SupabaseProvider>');
  }
  return ctx;
}
