# CLAUDE.md — WhatsApp Hub (Agentise)

## Visão geral

Plataforma open source self-hosted de automação WhatsApp. Uma instância
atende **múltiplas organizações totalmente isoladas** (multi-tenant, migrações
`20260810*_mt_*`): criação de templates assistida por IA, aprovação na Meta
via Zernio, disparos em massa por Broadcasts, agente de IA com RAG, inbox em
tempo real com handoff IA ↔ humano, dashboard analítico.

> Para o passo a passo de instalação pelo wizard `/setup`, consultar `README.md`. O `CLAUDE.md` foca
> em *como o código está organizado* e nas regras a respeitar ao alterá-lo.

## Multi-tenancy (organizações)

- **`whatsapp_hub.organizations`** (`id, name, slug, status active|archived`).
  TODAS as tabelas de domínio têm `org_id NOT NULL` (exceto o log
  `webhook_events`, nullable). UNIQUEs são
  org-scoped: `(org_id, phone)`, `(org_id, name)` etc. `app_settings`,
  `ai_agent_config` e `repurchase_config` viraram 1 linha POR ORG.
- **Claims no JWT** (`raw_app_meta_data`, espelhadas por `handle_new_user`):
  `role`, `org_id`, `home_org_id`, `is_super_admin`. Helpers SQL:
  `current_org_id()`, `is_super_admin()`, `current_org_active()`,
  `default_org_id()` (fallback só p/ integrações single-org legadas:
  landing).
- **RLS**: predicado único `org_id = current_org_id() AND current_org_active()`
  + gate de role. Org arquivada = acesso zero (webhooks descartam com 200,
  crons filtram `status='active'`). Super admin NÃO enxerga dados de domínio —
  gerencia orgs no console `/admin` e "entra" numa org via
  `api/admin/switch-org` (troca a claim `org_id` + `refreshSession()`).
- **DEFAULTs de `org_id`**: `current_org_id()` (JWT) nas tabelas de domínio;
  tabelas-filhas têm trigger `_org_from_parent` que herda o org da linha-pai
  (inserts via service role). Edge Functions devem SEMPRE gravar org_id
  explícito em `contacts`/`conversations`.
- **Credenciais POR ORG**: `public.org_settings (org_id, key, value_encrypted)`
  substitui o antigo `public.app_settings` global (mantido como legado).
  `getCredential(orgId, key)` nos dois runtimes; caches keyed por
  `${orgId}:${key}`.
- **Signup só via convite**: `handle_new_user` exige `invited_org_id` +
  `invited_role` no metadata (1º usuário da instância = admin + super admin da
  org padrão `principal`).
- **Canais (números WhatsApp)**: `whatsapp_hub.channels` — N números por org,
  `provider 'zernio'` (accountId oficial) ou `'uazapi'` (server_url + token
  cifrado AES-GCM na linha). `conversations.channel_id` / `campaigns.channel_id`
  carimbam o número; envio resolve contexto via
  `_shared/channels.ts::getSendContextForConversation`. `channels.assigned_member`
  = conversas entrantes daquele número são atribuídas automaticamente ao membro
  (fallback: round-robin da org). `channels.ai_enabled` (default true) = IA por
  número: refina o master switch `ai_agent_config.active_whatsapp` — com false,
  conversa nova nasce e é flipada pelo webhook para `human_active`+`ai_paused`
  via UPDATE (o flip dispara os triggers de handoff: notifica o operador
  vinculado, ou rodízio/fanout se o número não tem dono); `process-ai-message`
  também checa `ai_enabled` para conversas existentes. Cenários: número
  compartilhado da equipe = IA + rodízio; número pessoal de vendedor =
  `assigned_member` + `ai_enabled=false`. Webhook Zernio roteia por `?org=<uuid>` na URL
  (HMAC com o secret da org); webhook UAZAPI por `?secret=<channels.webhook_secret>`.
- **Foto de perfil de lead**: `contacts.profile_pic_url` — só via UAZAPI
  (`POST /chat/details`), refresh best-effort no webhook a cada 7 dias.
  Zernio/Meta não expõem foto de contato; fallback = iniciais.
- **Perfil de membro**: `app_users.display_name/avatar_url` (bucket público
  `whatsapp-hub-avatars`, path `<org_id>/<user_id>.<ext>`); campos sensíveis
  (`role`, `org_id`, `is_super_admin`) protegidos por trigger `_app_users_guard`.
- **Wizard `/setup`**: 3 passos (Preparar → Credenciais core → Bootstrap). As
  chaves de API (Zernio/OpenAI/UAZAPI) são configuradas DEPOIS, dentro do CRM,
  em `/settings` (Credenciais/Canais).

---

## Stack

- **Frontend.** React 18 + Vite + TypeScript + Tailwind CSS v4 + shadcn/ui.
- **Backend.** Supabase Cloud (Postgres, Auth, Realtime, Edge Functions,
  Storage, pgvector).
- **Jobs & Cron.** `pg_cron` + `pg_net` para disparos em batch e follow-ups.
- **API WhatsApp.** Zernio (`https://zernio.com/api/v1`) — intermediário que
  relaya para a Meta Cloud API. Toda comunicação (templates, broadcasts, inbox,
  mídia) passa pelo Zernio; o aluno conecta o WhatsApp no Zernio (Embedded
  Signup) e informa apenas a `ZERNIO_API_KEY`. Webhooks entram assinados com
  `X-Zernio-Signature` (HMAC-SHA256).
- **Embeddings.** OpenAI `text-embedding-3-small` (sempre, independente da
  LLM escolhida).
- **LLMs disponíveis.** OpenAI · Anthropic Claude · Google Gemini. A escolha
  fica na credencial `llm_provider` em `public.app_settings` (definida no
  wizard `/setup` ou em `/settings/credentials`) e é lida em runtime via
  `getCredential`. Não existe env var `LLM_PROVIDER`.
- **Transcrição de áudio.** OpenAI Whisper.
- **Idioma da interface.** Português BR (sem i18n no v1).

---

## Self-Hosted Setup

A instalação de produção é orientada pelo wizard `/setup`. Ele coleta os
tokens de bootstrap, roda migrations, deploya Edge Functions, configura as
envs core na Vercel e persiste credenciais de aplicação criptografadas em
`public.app_settings`.

---

## Arquitetura multi-schema (Supabase compartilhado)

O mesmo Supabase pode hospedar várias apps Agentise. Cada app vive em seu
próprio schema PostgreSQL.

### Schemas ativos

- `public` — reservado para extensions e tipos compartilhados (NÃO usar para
  dados de aplicação).
- `agentise_chat`
- `prospector`
- `crm_sofia`
- `whatsapp_hub` — **este projeto**.

### Regras de schema

1. Toda tabela de aplicação fica em `whatsapp_hub.*`.
2. Migrations começam com:
   ```sql
   CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
   SET search_path TO whatsapp_hub;
   ```
3. Cada schema tem seu próprio conjunto de policies RLS.
4. Nunca fazer cross-schema joins sem aprovação explícita.
5. Storage buckets prefixados: `whatsapp-hub-*`.
6. PostgREST precisa expor o schema (ver `README.md` passo 4).

### Padrão de queries no frontend

```ts
const { data } = await supabase
  .schema('whatsapp_hub')
  .from('conversations')
  .select('*');
```

Nunca usar o schema `public` para lógica de aplicação.

---

## Auth & Roles

- Supabase Auth com email/senha.
- Enum `whatsapp_hub.tenant_role` (nome herdado, semântica nova): valores
  permitidos `'admin' | 'operator'`.
- Trigger `whatsapp_hub.handle_new_user` em `auth.users`:
  - Se o convite trouxe `raw_user_meta_data.invited_role` = `'admin'` ou
    `'operator'`, usa esse valor.
  - Caso contrário, conta as linhas em `app_users`. Se zero, o novo usuário
    vira `admin`. Se ≥ 1, vira `operator`.
  - Insere em `app_users (user_id, role, accepted_at = now())`.
  - Espelha a role em `auth.users.raw_app_meta_data.role` para que policies
    possam consultá-la via JWT sem ler `app_users`.
- `app_users` é a tabela de membros da instância (substitui `tenant_members`
  do build SaaS antigo). UNIQUE por `user_id`.
- Policies RLS gateiam por `whatsapp_hub.current_user_role()`:
  - `'admin'` — controla templates, campanhas, knowledge, settings, equipe.
  - `'operator'` — opera inbox + contatos + tags do dia a dia.

---

## Banco de dados (schema `whatsapp_hub`)

### Tabelas centrais

```
app_settings (singleton, id = 1)
├── business_hours        JSONB   ({ mon: {start,end}, tue: ..., ... })
├── out_of_hours_message  TEXT
└── onboarding_completed  BOOLEAN  (mantido como flag de "settings preenchidos")

app_users
├── user_id  UUID  (FK auth.users, UNIQUE)
├── role     ENUM('admin','operator')
├── is_online  BOOLEAN
├── last_seen_at, accepted_at, created_at, invited_at

ai_agent_config  (singleton via UNIQUE INDEX em ((true)))
├── system_prompt TEXT
├── temperature   FLOAT DEFAULT 0.7
├── max_tokens    INT   DEFAULT 1000
├── is_active     BOOLEAN DEFAULT true

contacts
├── id, phone (E.164, UNIQUE), name, email
├── custom_fields JSONB

tags
├── id, name (UNIQUE), color

contact_tags  (N:N contact_id × tag_id)

templates
├── id, name (UNIQUE), category ENUM('marketing','utility','authentication') -- 'service' deprecado (atendimento livre não é template)
├── language DEFAULT 'pt_BR'
├── status ENUM('draft','pending','approved','rejected')
├── meta_template_id, meta_template_status
├── header_type, header_content
├── body, footer
├── buttons   JSONB
├── variables JSONB  (posição → descrição)
├── ai_prompt TEXT   (prompt original do usuário, quando gerado por IA)

campaigns
├── id, name, template_id
├── status ENUM('draft','scheduled','sending','completed','paused','failed')
├── scheduled_at      TIMESTAMPTZ NULL
├── audience_filter   JSONB (tags + custom_fields filters)
├── variable_mapping  JSONB (variável → contact field / CSV column)
├── total_contacts, sent, delivered, read, replied, failed  INT
├── zernio_broadcast_id   (broadcast mais recente que disparou a campanha)

campaign_contacts  (fila de disparo + métricas por contato)
├── id, campaign_id, contact_id
├── status ENUM('pending','sent','delivered','read','replied','failed')
├── error_message
├── sent_at, delivered_at, read_at, replied_at
├── zernio_message_id, zernio_conversation_id, zernio_broadcast_id
├── template_id_override   (per-row, usado por follow-ups)

follow_up_rules
├── trigger_condition ENUM('no_reply')
├── delay_hours INT
├── template_id   (template do follow-up)
├── sequence_order INT
├── is_active BOOLEAN

conversations
├── id, contact_id (UNIQUE)
├── status ENUM('ai_active','human_active','closed')
├── assigned_to UUID, assigned_at
├── ai_paused BOOLEAN DEFAULT false
├── last_message_at, unread_count
├── zernio_conversation_id   (id da conversa 1:1 no Zernio)

messages
├── id, conversation_id
├── direction ENUM('inbound','outbound')
├── sender_type ENUM('contact','ai','operator','system')
├── sender_id UUID (operador, opcional)
├── content_type ENUM('text','image','audio','video','document','template','note')
├── content TEXT, media_url TEXT
├── zernio_message_id, meta_status ENUM('sent','delivered','read','failed')  -- meta_status = status de entrega relayado pelo Zernio
├── is_private_note BOOLEAN DEFAULT false

webhook_events  (idempotência do zernio-webhook)
├── zernio_event_id TEXT PK, event_type, processed_at

knowledge_base
├── id, name, type ENUM('pdf','doc','url')
├── source_url, file_path, file_size_bytes
├── status ENUM('processing','ready','error')

knowledge_chunks
├── id, knowledge_base_id
├── content TEXT, embedding VECTOR(1536)
├── metadata JSONB

notifications
├── id, user_id, type ENUM('new_message','handoff','mention')
├── conversation_id, message_id
├── title, body, is_read
```

### Extensions (schema `public`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- RAG
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- helpers gerais
CREATE EXTENSION IF NOT EXISTS pg_cron;    -- jobs agendados
CREATE EXTENSION IF NOT EXISTS pg_net;     -- HTTP a partir do Postgres
```

### RLS

- Toda tabela de domínio tem RLS habilitado.
- Padrão: `SELECT` aberto a `authenticated`; `INSERT/UPDATE/DELETE` gated por
  `whatsapp_hub.current_user_role()`. Templates / campanhas / knowledge são
  admin-only para escrita; contatos / conversas / mensagens permitem
  operadores + admin.
- `app_settings` e `ai_agent_config` são singletons com escrita admin-only.
- `notifications` filtrada por `user_id = auth.uid()`.

### RPCs notáveis

- `whatsapp_hub.knowledge_search(p_query_embedding vector, p_top_k int)` —
  similarity search (cosine) no corpus, retornando `(id, knowledge_base_id,
  content, similarity)`.
- `whatsapp_hub.current_user_role()` — usado nas policies RLS.

### Credenciais e bootstrap (schema `public`)

Diferente das tabelas de domínio (que vivem em `whatsapp_hub`), o cofre de
credenciais e o estado de bootstrap ficam em `public` por serem infra de
instância, não dados de aplicação. Criadas pela migration
`20260521180500_setup_infra.sql`:

```
public.app_settings              <- SINGLE SOURCE OF TRUTH das credenciais
├── key             text PK       (ex.: zernio_api_key, zernio_account_id, zernio_profile_id, zernio_webhook_secret, zernio_number_info, llm_provider, ...)
├── value_encrypted text          (AES-256-GCM, formato "iv:tag:cipher")
└── updated_at      timestamptz

public._bootstrap_state           <- checkpoints idempotentes do wizard /setup
├── step         text PK          (connection_ok, migrations_done, owner_created, ...)
├── completed_at timestamptz
└── metadata     jsonb            (nunca guarda senha; só user_id/email/count)
```

- **Não confundir** com `whatsapp_hub.app_settings` (o singleton de
  `business_hours` / `out_of_hours_message`). São tabelas distintas, em schemas
  distintos, com propósitos distintos.
- Ambas têm RLS habilitado **sem nenhuma policy** → inacessíveis a `anon` e
  `authenticated`. Só a service role (API Routes Vercel + Edge Functions) lê e
  escreve. O frontend nunca consulta `app_settings` diretamente.
- **Leitura — `getCredential(key)` é o único acessador**, sobre `app_settings`:
  - Node (API Routes): `src/lib/credentials.ts`
    (`encrypt`/`decrypt`/`getCredential`/`setCredential`).
  - Deno (Edge Functions): `_shared/credentials.ts` (decrypt-only + cache 60s).
  - `_shared/tenant-credentials.ts::loadAppCredentials()` é apenas um **wrapper
    tipado** sobre `getCredential` — não é fonte de verdade e não lê env vars.
- **Escrita** só via `api/credentials.ts` (`setCredential`), que valida cada
  valor server-side e exige sessão de owner/admin.
- `CRYPTO_KEY` (env core) decifra os valores; sem ela os dados em
  `app_settings` são irrecuperáveis.

---

## pg_cron jobs

| Job                     | Cadência     | Função                  |
|-------------------------|--------------|-------------------------|
| `dispatch-campaigns`    | 30 segundos  | `dispatch-campaign`     |
| `check-follow-ups`      | a cada 15min | `check-follow-ups`      |

> O antigo `check-template-status` (polling 5min) foi removido — o status do
> template chega pelo webhook `whatsapp.template.status_updated`.

Os jobs invocam Edge Functions via `pg_net.http_post`. URL do projeto e
service role key vêm de Vault entries (`whatsapp_hub_supabase_url`,
`whatsapp_hub_service_role_key`) seedadas pelo `npm run db:push`.

---

## Funcionalidades

### Templates com IA

1. Operador escolhe categoria (Marketing / Utility / Authentication), descreve
   o objetivo, marca variáveis e tipo de header. ("Service" não é categoria de
   template — atendimento livre é resposta dentro da janela de 24h.)
2. Frontend chama `generate-template`. A função lê o provider de
   `app_settings` (`getCredential('llm_provider')`), monta o prompt e devolve
   o template estruturado.
3. Operador revisa, edita se quiser, e submete. `submit-template` envia ao
   Zernio: `POST /whatsapp/templates` com `{accountId, name,
   category(MARKETING|UTILITY|AUTHENTICATION), language, components}`.
4. O status (`approved` / `rejected`) chega pelo webhook
   `whatsapp.template.status_updated` — sem polling.

### Disparos em massa

1. Selecionar template aprovado.
2. Audiência: tags + filtros custom + upload CSV/XLSX (E.164 + dedup).
3. Mapear variáveis → campos do contato / colunas do CSV.
4. Agendar ou disparar imediatamente.
5. `dispatch-campaign` (cron 30s) lê batch de `campaign_contacts.pending`,
   agrupa por template e cria **Broadcasts** no Zernio (criar → adicionar
   destinatários em lotes de 100 → `send`). Batching, retry e rate-limit ficam
   por conta do Zernio — sem loop de tier/backoff próprio. Grava
   `zernio_broadcast_id` por linha para correlação dos status.
6. `zernio-webhook` ingere statuses (sent / delivered / read / failed) e
   incrementa contadores agregados na campanha.

### Follow-up rules

- Cadeia ordenada por `sequence_order` (1, 2, 3 …).
- `check-follow-ups` (cron 15min) acha `campaign_contacts` cujo status ≠
  `replied` e cujo `sent_at + delay_hours < now()`, e enfileira nova
  mensagem com `template_id_override` apontando ao template do follow-up.
- Resposta do contato em qualquer ponto cancela follow-ups futuros.

### Agente IA + RAG

- Knowledge base aceita PDFs, docs e URLs (até 30MB no total).
- `process-knowledge`: extract → chunk (500 tokens, overlap 50) → embed
  (`text-embedding-3-small`, 1536d) → store em `knowledge_chunks`.
- Mensagem inbound aciona `process-ai-message`:
  1. Gate: conversa não fechada/pausada + `ai_agent_config.is_active` +
     toggle da plataforma (`active_whatsapp`/`active_instagram`) +
     `channels.ai_enabled` do número da conversa (sem `channel_id` = habilitado).
     Se qualquer um falhar, flipa a conversa para `human_active`+`ai_paused`
     (dispara os triggers de handoff) e não responde.
  2. Busca top-5 chunks via `knowledge_search`.
  3. Monta prompt com `system_prompt` (do `ai_agent_config`) + contexto +
     histórico da conversa.
  4. Chama o provider configurado na credencial `llm_provider`.
  5. Envia resposta via Zernio (mensagem 1:1 na inbox, dentro da janela de 24h).
- Handoff: operador clica "Pausar IA" → `conversation.ai_paused = true` →
  triggers do flip false→true: `_on_handoff_autoassign` (round-robin da fila
  `lead_assignment_queue`, só membros `is_online`, apenas se `assigned_to IS
  NULL` e `auto_assign_enabled`) e `_on_handoff_notify` (notifica só o
  responsável; sem responsável, fanout para todos operadores).
- Áudio do contato → `transcribe-audio` baixa o áudio da URL do attachment
  (entregue pelo webhook do Zernio) → Whisper → salva como `content`, mantendo
  `media_url`.

### Inbox

- Layout 3 painéis (lista de conversas, thread, dados do contato).
- Realtime via Supabase Realtime nos canais de `messages` e `conversations`,
  populados pelos webhooks do Zernio (`message.received` + status).
- Mídia do operador: `send-operator-media` sobe o arquivo via Zernio
  `/media/upload-direct` (máx 25MB) e envia com `attachmentUrl`.
- Notas privadas (`is_private_note = true`) — fundo diferenciado, locais, nunca
  enviadas ao Zernio.
- Atribuição automática, nesta ordem: (1) `channels.assigned_member` do número
  atribui a conversa na chegada (webhook); (2) senão, no handoff, round-robin
  da fila entre operadores com `is_online = true`. Manual nunca é sobrescrito.
- Filtros: status, assigned_to, tags, período.

### Dashboard

- Cards de métricas (mensagens enviadas / entregues / lidas / respondidas,
  com trend %).
- Métricas secundárias: custo por conversa (pricing Meta por categoria + país —
  o Zernio repassa o preço da Meta, zero markup), tempo médio de resposta da IA,
  tempo médio do humano, distribuição de status das conversas.
- Widget de saúde do número (tier / quality / health) via `zernio-number-status`
  (cache de `number-info`).
- Gráficos Recharts: line (volume / dia), bar (taxas por campanha), donut
  (status).

---

## Estrutura de pastas (frontend)

```
src/
├── app/
│   ├── routes/
│   │   ├── setup/            Bootstrap Supabase (URL + anon key → localStorage)
│   │   ├── auth/             Login, signup
│   │   ├── dashboard/
│   │   ├── inbox/
│   │   ├── campaigns/
│   │   ├── templates/
│   │   ├── contacts/
│   │   ├── knowledge/
│   │   ├── follow-ups/
│   │   └── settings/
│   │       ├── SettingsPage.tsx
│   │       └── sections/
│   │           ├── AccountSettings.tsx
│   │           ├── AIAgentSettings.tsx
│   │           ├── BusinessHoursSettings.tsx
│   │           ├── SupabaseSettings.tsx
│   │           └── TeamSettings.tsx
│   ├── layout/               AppLayout, Sidebar, Header
│   ├── router.tsx            RequireSetup → RequireSession → AppLayout
│   └── providers/
│       ├── SupabaseProvider.tsx
│       ├── AuthProvider.tsx
│       └── AppUserProvider.tsx   (consome app_users, expõe role)
├── components/
│   ├── ui/                   primitives shadcn
│   ├── inbox/                ChatBubble, ConversationList, NoteInput, …
│   ├── campaigns/            CampaignWizard, VariableMapper, AudienceSelector
│   ├── templates/            TemplateEditor, TemplatePreview, AIGenerator
│   ├── contacts/             ContactTable, CSVUploader, TagManager
│   └── NotificationsDropdown.tsx
├── hooks/                    useCampaigns, useConversations, useTemplates,
│                             useContacts, useKnowledgeBase, useDashboardMetrics,
│                             useFollowUpRules, useMessages, useNotifications,
│                             useTags, useSupabase
├── lib/                      supabase.ts (dynamic client), phone.ts (E.164)
├── types/                    db, inbox, campaigns, templates, knowledge
└── styles/globals.css        Tailwind v4 + dark glassmorphism tokens
```

## Edge Functions

```
supabase/functions/
├── _shared/
│   ├── auth.ts               requireCaller, requireAdmin (JWT validation)
│   ├── cors.ts               jsonResponse, preflight
│   ├── llm.ts                multi-provider adapter (OpenAI/Claude/Gemini)
│   ├── supabase-admin.ts     service role client
│   ├── credentials.ts        getCredential()/setCredential() sobre public.app_settings (SSOT)
│   ├── tenant-credentials.ts loadAppCredentials() → wrapper tipado de getCredential
│   └── zernio.ts             client Zernio (inbox, broadcasts, templates, mídia, number-info)
├── zernio-webhook/           ingestão (X-Zernio-Signature) de statuses + inbound; idempotência via webhook_events
├── dispatch-campaign/        consumido por pg_cron 30s — cria Broadcasts no Zernio
├── check-follow-ups/         consumido por pg_cron 15min
├── process-ai-message/       RAG → LLM → resposta via Zernio (inbox 1:1)
├── process-knowledge/        upload → chunk → embed → store
├── transcribe-audio/         baixa áudio da URL do attachment (Zernio) → Whisper
├── generate-template/        prompt → LLM → JSON estruturado de template
├── submit-template/          POST p/ Zernio `/whatsapp/templates`
├── send-operator-message/    operador envia texto / nota privada pela inbox
├── send-operator-media/      operador envia mídia (upload-direct → attachmentUrl)
├── zernio-number-status/     status cacheado do número (tier/quality/health) p/ dashboard
├── simulate-inbound/         dev only — finge mensagem inbound
├── test-zernio-connection/   valida a conexão Zernio (GET /whatsapp/number-info)
└── invite-team-member/       convite nativo do Supabase Auth (inviteUserByEmail + invited_role)
```

---

## Convenções de código

### Geral
- TypeScript strict mode.
- ESLint + Prettier.
- Componentes: PascalCase. Hooks: `useThing.ts`. Edge Functions: kebab-case.
- Comentários: português para regra de negócio; inglês para código técnico.

### Supabase / frontend
- Client criado via `getSupabase()` a partir das envs core injetadas no build
  apos o wizard `/setup`.
- **Sempre** usar `.schema('whatsapp_hub')` no client.
- Tipos manuais em `src/types/`. Não usamos `supabase gen types` no v1.

### Edge Functions
- Toda função pública passa pelos helpers `_shared/auth.ts`. Nunca pular essa
  validação.
- Credenciais de aplicação têm como **fonte de verdade** `public.app_settings`
  e são lidas via `getCredential` (`_shared/credentials.ts`).
  `_shared/tenant-credentials.ts::loadAppCredentials()` é só um wrapper tipado
  sobre ele — nunca lê env vars de aplicação. `Deno.env.get(...)` fica restrito
  a envs core (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRYPTO_KEY`).
- Resposta padrão: `{ data, error, message }` via `jsonResponse`.
- Logging estruturado: `console.log(JSON.stringify({ event, ... }))`.

### Segurança
- HMAC-SHA256 (timing-safe) na validação do webhook Meta.
- Tokens / API keys nunca trafegam pelo frontend — todas as chamadas a
  Meta / OpenAI / Claude / Gemini saem das Edge Functions.

---

## Design System — Dark Mode Glassmorphism (OBRIGATÓRIO)

A plataforma é **dark mode only**. Não implementar light mode. Não criar
toggle de tema.

### Tokens de cor

| Token                  | Valor                                        |
|------------------------|----------------------------------------------|
| `--bg-primary`         | `#0A0A0F`                                    |
| `--bg-card`            | `rgba(15, 18, 35, 0.6)`                      |
| `--border-card`        | `rgba(59, 130, 246, 0.15)`                   |
| `--accent-primary`     | `#3B82F6`                                    |
| `--accent-secondary`   | `#60A5FA`                                    |
| `--gradient-primary`   | `linear-gradient(135deg, #1E3A8A, #3B82F6)`  |
| `--text-primary`       | `#F8FAFC`                                    |
| `--text-secondary`     | `#94A3B8`                                    |
| `--text-label`         | `#CBD5E1`                                    |
| `--color-success`      | `#10B981`                                    |
| `--color-error`        | `#EF4444`                                    |

### Background glow (no `body`)

```css
body {
  background-color: #0A0A0F;
  background-image:
    radial-gradient(ellipse at 20% 0%, rgba(59, 130, 246, 0.06), transparent 50%),
    radial-gradient(ellipse at 80% 100%, rgba(37, 99, 235, 0.04), transparent 50%);
  min-height: 100vh;
}
```

### Glass card padrão

```css
.glass-card {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.02));
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 16px;
  box-shadow:
    0 0 20px rgba(59, 130, 246, 0.06),
    inset 0 1px 0 rgba(59, 130, 246, 0.1);
}

.glass-card:hover {
  border-color: rgba(59, 130, 246, 0.45);
  box-shadow:
    0 0 30px rgba(59, 130, 246, 0.12),
    0 0 60px rgba(59, 130, 246, 0.04),
    inset 0 1px 0 rgba(59, 130, 246, 0.2);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Tipografia

```css
* { font-family: 'Inter', sans-serif; }

.text-display { font-weight: 700; }
.text-stat    { font-size: 2.5rem; font-weight: 800; }

.text-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.text-body { font-weight: 400; font-size: 0.875rem; }
```

### Bordas e separadores

- Borders padrão: `rgba(59, 130, 246, 0.12)`.
- Dividers: `rgba(59, 130, 246, 0.08)`.
- Sidebar `border-right`: `1px solid rgba(59, 130, 246, 0.1)`.
- Header `border-bottom`: `1px solid rgba(59, 130, 246, 0.08)`.

Componentes devem usar `var(--accent-primary)` / `var(--accent-secondary)` em
vez de hardcodear `#3B82F6` / `#60A5FA`. Os hex listados acima são apenas o
fallback default.

---

## Notas de migração e variáveis não-triviais

- `tenant_members` foi renomeada para `app_users` na Fase 4 da migração SaaS
  → OSS. O enum `whatsapp_hub.tenant_role` manteve o nome por inércia, mas
  hoje só aceita `'admin' | 'operator'`.
- A fonte de verdade das credenciais de aplicação é `public.app_settings`
  (KV criptografado), acessada por `getCredential`/`setCredential`.
  `_shared/tenant-credentials.ts` mantém o nome histórico, mas hoje é só um
  wrapper tipado sobre `getCredential` — não lê env vars nem é fonte própria.
- `campaign_contacts.template_id_override` é per-row e existe para que o
  dispatcher use um template diferente do template-pai da campanha em
  follow-ups.
- `raw_user_meta_data.invited_role` no convite é o canal pelo qual
  `handle_new_user` aceita um valor pré-definido de role. Sem ele, a regra
  default (1º usuário = admin, demais = operator) decide.
- A Vault entry `whatsapp_hub_encryption_key` ainda existe por motivos
  históricos (a migração `20260422120012` a cria), mas nenhum código atual
  consome `encrypt_secret`/`decrypt_secret`.
- **Migração Meta Cloud API → Zernio.** Toda a comunicação WhatsApp passou a
  sair pelo client `_shared/zernio.ts` (Deno) e `src/lib/zernio.ts` (Node, só no
  setup). Mudanças não óbvias:
  - `messages.meta_message_id`/`campaign_contacts.meta_message_id` renomeados
    para `zernio_message_id`. `meta_status` foi **mantido** (é o status de
    entrega genérico, agora relayado pelo Zernio) para não tocar tipos do
    frontend.
  - Colunas novas: `conversations.zernio_conversation_id`,
    `campaign_contacts.zernio_conversation_id/zernio_broadcast_id`,
    `campaigns.zernio_broadcast_id`. Tabela `webhook_events` (idempotência).
  - Disparo em massa usa **Broadcasts** do Zernio (não o loop por-contato na
    Meta); o motor de follow-up próprio (pg_cron) foi mantido — não migrou para
    Sequences do Zernio.
  - Convites são 100% Supabase Auth nativo (`invite-team-member` →
    `inviteUserByEmail`); o Resend, a tabela `invites` e o link com token foram
    removidos.
  - O `meta_tier` (enum + credencial) saiu; o tier vem de `number-info`,
    cacheado na credencial `zernio_number_info`.
  - Vários shapes de payload do Zernio (webhook inbound/status, `upload-direct`,
    corpo do send message, endpoint de registro de webhook) estão marcados
    `ASSUMIDO` no código — confirmar contra a API real no 1º teste de integração.
