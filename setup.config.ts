export type CredentialField = {
  key: string;
  label: string;
  helpText?: string;
  docsUrl?: string;
  placeholder?: string;
  inputType?: 'text' | 'password';
  validate: (value: string) => Promise<{ ok: boolean; message?: string }>;
};

export type SetupConfig = {
  toolName: string;
  toolSlug: string;
  appCredentials: CredentialField[];
  postBootstrapRedirect: string;
};

const ok = { ok: true } as const;

async function validateOpenAI(value: string) {
  if (!value.startsWith('sk-')) {
    return { ok: false, message: 'A chave OpenAI deve comecar com sk-.' };
  }
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${value}` },
  });
  return res.ok
    ? ok
    : { ok: false, message: 'Chave OpenAI invalida ou sem permissao.' };
}

async function validateAnthropic(value: string) {
  if (!value.startsWith('sk-ant-')) {
    return { ok: false, message: 'A chave Anthropic deve comecar com sk-ant-.' };
  }
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': value,
      'anthropic-version': '2023-06-01',
    },
  });
  return res.ok
    ? ok
    : { ok: false, message: 'Chave Anthropic invalida ou sem permissao.' };
}

async function validateGemini(value: string) {
  if (!value.startsWith('AIza')) {
    return { ok: false, message: 'A chave Gemini normalmente comeca com AIza.' };
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
  );
  return res.ok
    ? ok
    : { ok: false, message: 'Chave Gemini invalida ou sem permissao.' };
}

// Base da API Zernio. Pode ser sobrescrita por env (testes/staging); cai no
// dominio publico por padrao. Lida server-side (api/validate, api/zernio-connect)
// e tambem aqui no validator de campo, que so roda no servidor.
export const ZERNIO_API_BASE_URL =
  (typeof process !== 'undefined' ? process.env?.ZERNIO_API_BASE_URL : undefined) ||
  'https://zernio.com/api/v1';

async function validateZernio(value: string) {
  const v = value.trim();
  if (!/^sk_[a-f0-9]{64}$/i.test(v)) {
    return {
      ok: false,
      message: 'A chave Zernio deve ter o formato sk_ seguido de 64 caracteres hex.',
    };
  }
  // Ping real: GET /accounts confirma que a chave autentica no Zernio. A
  // resolucao de accountId/profileId/numero acontece no salvar (zernio-connect).
  const res = await fetch(`${ZERNIO_API_BASE_URL}/accounts`, {
    headers: { Authorization: `Bearer ${v}` },
  });
  return res.ok
    ? ok
    : { ok: false, message: 'Chave Zernio invalida ou sem permissao.' };
}

export const setupConfig: SetupConfig = {
  toolName: 'Mega CRM',
  toolSlug: 'whatsapp-hub',
  postBootstrapRedirect: '/dashboard',
  // O aluno conecta o WhatsApp dentro do Zernio (Embedded Signup) e informa
  // apenas a Zernio API Key. accountId/profileId/tier/numero sao resolvidos
  // server-side no salvar (api/zernio-connect). Nada da Meta e coletado aqui.
  appCredentials: [
    {
      key: 'zernio_api_key',
      label: 'Zernio API Key',
      placeholder: 'sk_...',
      inputType: 'password',
      docsUrl: 'https://zernio.com/dashboard/api-keys',
      helpText:
        'Conecte o WhatsApp no Zernio (Embedded Signup) e cole a API Key aqui. O numero, o tier e o webhook sao configurados automaticamente.',
      validate: validateZernio,
    },
    {
      key: 'openai_api_key',
      label: 'OpenAI API Key',
      placeholder: 'sk-...',
      inputType: 'password',
      docsUrl: 'https://platform.openai.com/api-keys',
      helpText: 'Obrigatoria para embeddings e transcricao de audio (Whisper).',
      validate: validateOpenAI,
    },
    {
      key: 'llm_provider',
      label: 'LLM Provider',
      placeholder: 'openai',
      inputType: 'text',
      helpText: 'openai, claude ou gemini. Deixe vazio para usar openai (padrao).',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // vazio = padrao openai
        return ['openai', 'claude', 'gemini'].includes(v)
          ? ok
          : { ok: false, message: 'Use openai, claude ou gemini.' };
      },
    },
    {
      key: 'llm_api_key',
      label: 'LLM API Key',
      placeholder: 'sk-...',
      inputType: 'password',
      helpText:
        'Chave do provider de chat. Obrigatoria apenas se o provider nao for OpenAI; com OpenAI, reusa a OpenAI API Key.',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // vazio: cai na OpenAI API Key quando provider = openai
        if (v.startsWith('sk-ant-')) return validateAnthropic(v);
        if (v.startsWith('AIza')) return validateGemini(v);
        return validateOpenAI(v);
      },
    },
    {
      key: 'app_url',
      label: 'App URL',
      placeholder: 'https://seu-app.vercel.app',
      inputType: 'text',
      helpText: 'Opcional. URL publica usada em links de convite. Derivada do deploy se vazia.',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // opcional
        return /^https:\/\/.+/i.test(v)
          ? ok
          : { ok: false, message: 'Informe uma URL HTTPS publica.' };
      },
    },
    {
      // Integração DIRETA com a UAZAPI (segundo número de WhatsApp, sem janela
      // de 24h). Base URL da instância — ex.: https://free.uazapi.com.
      key: 'uazapi_server_url',
      label: 'UAZAPI Server URL',
      placeholder: 'https://free.uazapi.com',
      inputType: 'text',
      helpText: 'Opcional. URL do servidor da sua instância UAZAPI.',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // opcional: sem UAZAPI = só WhatsApp Meta oficial
        return /^https:\/\/.+/i.test(v)
          ? ok
          : { ok: false, message: 'Informe uma URL HTTPS (ex.: https://free.uazapi.com).' };
      },
    },
    {
      key: 'uazapi_instance_token',
      label: 'UAZAPI Instance Token',
      placeholder: 'token da instância',
      inputType: 'password',
      helpText:
        'Opcional. Token da instância UAZAPI. Após salvar, use "Cadastrar webhook na UAZAPI Automaticamente".',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // opcional
        return v.length >= 8 ? ok : { ok: false, message: 'Token muito curto.' };
      },
    },
    {
      // Token do canal Instagram (via Zernio). Gerenciado pelo card
      // "Canais" em Configuracoes; oculto da lista de Credenciais.
      key: 'instagram_access_token',
      label: 'Instagram Access Token',
      placeholder: 'IG...',
      inputType: 'password',
      helpText: 'Token do Instagram conectado no Zernio. Cifrado no banco (CRYPTO_KEY).',
      validate: async (value) => {
        const v = value.trim();
        if (!v) return ok; // opcional: sem token = canal desligado
        return v.length >= 8 ? ok : { ok: false, message: 'Token muito curto.' };
      },
    },
  ],
};
