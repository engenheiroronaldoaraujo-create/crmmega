import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Lê o singleton ai_agent_config e diz se a IA atende um canal. Com a IA do
// canal desligada nas configurações, o inbox exibe "Humano" no lugar de "IA"
// (apresentação — o processamento já é bloqueado server-side).
export function useAiChannels(): { aiEnabledForChannel: (channel: string | null) => boolean } {
  const [config, setConfig] = useState<{ is_active: boolean; active_whatsapp: boolean; active_instagram: boolean } | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    void supabase
      .from('ai_agent_config')
      .select('is_active, active_whatsapp, active_instagram')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setConfig({
            is_active: Boolean(data.is_active),
            active_whatsapp: Boolean(data.active_whatsapp ?? true),
            active_instagram: Boolean(data.active_instagram ?? false),
          });
        }
      });
  }, []);

  const aiEnabledForChannel = useCallback(
    (channel: string | null) => {
      if (!config) return true; // sem config carregada, mantém o comportamento atual
      if (!config.is_active) return false;
      return channel === 'instagram' ? config.active_instagram : config.active_whatsapp;
    },
    [config],
  );

  return { aiEnabledForChannel };
}
