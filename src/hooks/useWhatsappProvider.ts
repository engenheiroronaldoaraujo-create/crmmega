import { useCallback } from 'react';

export type WhatsappProvider = 'meta' | 'uazapi' | 'instagram';

// Distingue o provedor de cada conversa. `conversations.provider` é carimbado
// pelos webhooks (zernio-webhook → 'zernio'; uazapi-webhook → 'uazapi', o
// último inbound decide). UAZAPI é integração direta sem janela de 24h;
// WhatsApp via Zernio é a API oficial da Meta.
export function useWhatsappProvider(): {
  providerOf: (conv: { channel: string | null; provider?: string | null }) => WhatsappProvider;
} {
  const providerOf = useCallback(
    (conv: { channel: string | null; provider?: string | null }): WhatsappProvider => {
      if (conv.channel === 'instagram') return 'instagram';
      return conv.provider === 'uazapi' ? 'uazapi' : 'meta';
    },
    [],
  );
  return { providerOf };
}
