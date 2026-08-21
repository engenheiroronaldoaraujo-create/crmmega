# Mega CRM (Agentise)

Plataforma self-hosted de automacao WhatsApp para uma unica organizacao:
templates assistidos por IA, campanhas em massa, inbox em tempo real,
handoff IA/humano, RAG e dashboard operacional.

A comunicacao com o WhatsApp passa pelo **Zernio** (intermediario que relaya
para a Meta Cloud API): o aluno conecta o WhatsApp no Zernio (Embedded Signup,
poucos cliques) e informa apenas a `ZERNIO_API_KEY` no wizard — sem coletar
WABA ID, tokens ou App Secret da Meta.

## Stack

- Frontend: React 18, Vite, TypeScript, Tailwind, shadcn/ui.
- Backend: Supabase Postgres, Auth, Realtime, Edge Functions, Storage, pgvector, pg_cron e pg_net.
- WhatsApp: Zernio API (`https://zernio.com/api/v1`).
- Deploy: Vercel.

## Setup Para Alunos

1. Acesse o painel Agentise e siga o fluxo para criar sua copia do template.
2. Importe o projeto na Vercel.
3. Abra a URL deployada e siga o wizard em `/setup`.

O wizard coleta as credenciais, roda migrations, deploya Edge Functions,
configura as envs core na Vercel e salva as credenciais de aplicacao
criptografadas no Supabase da propria instancia.

Mais detalhes ficam no painel Agentise.

## Credenciais

Em producao, somente quatro envs core existem na Vercel:

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRYPTO_KEY=
```

Credenciais de aplicacao, como a Zernio API Key (WhatsApp), OpenAI, Anthropic e
Gemini, nao ficam em `.env` nem em Supabase secrets. Elas sao gerenciadas por
`/settings/credentials` e persistidas criptografadas em `public.app_settings`,
a unica fonte de verdade. Todo o codigo as le pelo acessador `getCredential`
(`src/lib/credentials.ts` no Node, `supabase/functions/_shared/credentials.ts`
no Deno); `tenant-credentials.ts` e apenas um wrapper tipado sobre ele.

Nao delete `CRYPTO_KEY` da Vercel. Sem ela, os valores criptografados em
`public.app_settings` nao podem ser recuperados.

## Troubleshooting: campanhas presas em "Enviando"

O pg_cron invoca o Edge Function `dispatch-campaign` a cada 30 segundos. Se
campanhas ficam presas em "Enviando" sem enviar, verifique:

### 1. Vault secret `whatsapp_hub_service_role_key`

O cron autentica com o segredo da Vault. Se nao existir, toda invocacao
retorna 403. Verificar no SQL Editor do Supabase:

```sql
SELECT name FROM vault.decrypted_secrets
 WHERE name = 'whatsapp_hub_service_role_key';
```

Se nao retornar nada, insira manualmente (substitua `<SERVICE_ROLE_KEY>` pela
chave real do projeto — em Settings > API > service_role):

```sql
SELECT vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'whatsapp_hub_service_role_key',
  'Service role JWT used by pg_cron to authenticate to Edge Functions'
);
```

### 2. Credenciais Zernio

O dispatcher precisa de tres credenciais em `public.org_settings` (ou
`public.app_settings` como fallback):

- `zernio_api_key`
- `zernio_account_id`
- `zernio_profile_id`

Configurar em `/settings/credentials` (Canais).

### 3. Template aprovado

O template da campanha precisa ter `status = 'approved'` no banco. Templates
com status `pending` ou `rejected` fazem os contatos serem marcados como
`failed` com a mensagem "Template nao aprovado pela Meta ou nao encontrado".

### 4. Botao "Testar dispatch"

Na pagina de Campanhas, o botao "Testar dispatch" executa o dispatcher
manualmente e mostra o JSON de resultado com erros detalhados.

## Desenvolvimento Local

```bash
npm install
npm run dev
```

Para testar bootstrap real, use uma instancia Supabase e Vercel descartavel,
pois o wizard aplica migrations, deploya Edge Functions e dispara redeploy.

## Estrutura

```text
api/                         Vercel Serverless Functions
src/app/routes/setup/        Wizard /setup
src/app/routes/settings/     Credenciais e configuracoes internas
src/components/credentials/  Campo reutilizavel de credenciais
src/lib/credentials.ts       Criptografia server-side
supabase/functions/          Edge Functions
supabase/migrations/         Migrations SQL
setup.config.ts              Manifesto de credenciais da ferramenta
```

## Licenca

MIT.
