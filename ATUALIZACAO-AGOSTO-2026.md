# Atualização do CRM — Agosto/2026

## 👤 Instruções para você, aluno (leia antes)

Este arquivo serve para **atualizar o seu CRM atual sem perder as alterações
que você fez nele**. Quem executa a atualização é o Claude Code — este
documento contém as instruções que ele vai seguir.

Passo a passo:

1. **Faça backup** do seu banco (Supabase) e do seu repositório antes de
   qualquer coisa.
2. Baixe o **.zip da versão atualizada do CRM dentro da Agentise** e extraia
   em uma pasta FORA do seu repositório (ex.: `~/Downloads/megacrm-novo`).
   O Claude Code vai usar essa pasta como código de referência.
3. Copie **este arquivo** (`ATUALIZACAO-AGOSTO-2026.md`) para a **raiz da
   pasta do seu CRM**.
4. Abra o Claude Code (ou qualquer IA de código da sua preferência) na pasta
   do seu CRM e peça para ele ler este arquivo — ou cole o prompt abaixo,
   ajustando o caminho da pasta extraída:

```
Leia o arquivo ATUALIZACAO-AGOSTO-2026.md na raiz deste repositório e execute
o processo de atualização descrito na seção "Instruções para o Claude Code".
A pasta da versão nova (código de referência) está em:
~/Downloads/megacrm-novo   ← ajuste para o caminho onde você extraiu o zip
```

5. O Claude vai primeiro **auditar** o seu CRM e te apresentar um **plano**.
   Leia o plano e aprove (ou ajuste) antes de ele mudar qualquer arquivo.

> Se você **nunca alterou nada** no seu CRM, não precisa deste documento:
> reinstale do zero usando o .zip atualizado da Agentise, que já vem com tudo.

---

## 🤖 Instruções para o Claude Code

Você está no repositório do CRM do aluno, baseado na versão de julho/2026 e
possivelmente com alterações próprias dele. O usuário informou o caminho da
**versão nova** (código de referência completo). Se ele não informou, pergunte
antes de começar — você vai precisar dela.

Execute as três fases abaixo, nesta ordem.

### Fase 1 — AUDITORIA (antes de escrever qualquer código)

- Compare este repositório com a versão nova (migrations, `supabase/functions/`,
  `api/`, `src/`) e identifique: (a) o que a versão nova adiciona; (b) o que o
  aluno alterou ou criou por conta própria.
- Para cada feature da lista deste documento, classifique:
  - **AUSENTE** neste repo → implementar, copiando da versão nova.
  - **PARCIAL** (o aluno fez algo parecido, mas incompleto) → mesclar:
    preservar o trabalho do aluno e completar com o que falta.
  - **EQUIVALENTE OU MELHOR** (a implementação do aluno cobre o mesmo caso
    igual ou mais completa) → **não fazer nada** nessa feature. Não
    sobrescreva nem "melhore" o que já resolve o problema.
- Features próprias do aluno que a versão nova não tem: preservar intocadas;
  apenas garantir compatibilidade com o multi-tenancy (org_id + RLS).
- Apresente a classificação como um plano, feature por feature, com a
  justificativa de cada decisão, e **espere a aprovação do aluno** antes de
  mudar qualquer arquivo.

### Fase 2 — IMPLEMENTAÇÃO (após aprovação do plano)

- Siga a ordem de dependência da lista abaixo (multi-tenancy primeiro; tudo
  depois dela pressupõe `org_id`).
- Use os arquivos da versão nova como fonte de verdade: prefira copiar o
  arquivo/migration inteiro quando o aluno não tiver mexido nele; mescle
  manualmente quando houver alterações dele no mesmo arquivo.
- Migrations: **nunca edite migrations já aplicadas** no banco do aluno.
  Copie as novas mantendo nomes/timestamps originais e aplique com
  `npm run db:push`. Se uma migration do aluno conflitar com uma nova (mesma
  tabela/coluna), crie uma migration de reconciliação nova em vez de editar
  as existentes.
- Ao final de cada bloco de feature: `npm run build` (typecheck) e
  `npm run validate:sql` precisam passar.

### Fase 3 — VERIFICAÇÃO

Gere um relatório final: o que foi implementado, o que foi mesclado, o que
foi pulado (e por quê), e o que exige ação manual do aluno (deploy de
functions, configuração em /settings, reconfiguração de webhooks etc.).

---

## Features novas (em ordem de implementação)

A ordem importa: **multi-tenancy é a fundação** — as demais features assumem
`org_id` em todas as tabelas e os canais por organização.

### 1. Multi-tenancy com organizações isoladas 🏢

Uma instância passa a atender N organizações totalmente isoladas.

- **Migrations**: `20260810120000_mt_schema.sql`, `20260810120001_mt_backfill.sql`,
  `20260810120002_mt_policies.sql`, `20260810120003_avatars_bucket.sql`,
  `20260811120000_mt_agent_media_org_scope.sql`.
- **O que fazem**: tabela `whatsapp_hub.organizations`; `org_id NOT NULL` em
  ~45 tabelas de domínio (backfill para a org padrão `principal`); claims no
  JWT (`org_id`, `home_org_id`, `is_super_admin`) espelhadas por
  `handle_new_user`; helpers `current_org_id()`, `is_super_admin()`,
  `current_org_active()`, `default_org_id()`; RLS reescrita com predicado
  `org_id = current_org_id() AND current_org_active()` + gate de role;
  UNIQUEs viram org-scoped (`(org_id, phone)` etc.); credenciais migram de
  `public.app_settings` (global) para `public.org_settings` (por org);
  triggers `_org_from_parent` nas tabelas-filhas; bucket público
  `whatsapp-hub-avatars`.
- **Backend**: `api/admin/` (console de orgs + switch-org), `_shared/credentials.ts`
  vira `getCredential(orgId, key)` — **todas** as Edge Functions passam a
  carregar credenciais por org e a gravar `org_id` explícito em
  `contacts`/`conversations`.
- **Frontend**: `src/app/routes/admin/` (console super admin),
  `src/app/layout/OrgSwitcher.tsx`, `AppUserProvider` com org/role,
  perfil de membro com avatar (`src/components/ui/Avatar.tsx`).
- ⚠️ **Atenção na auditoria**: se o aluno criou tabelas próprias, elas
  precisam ganhar `org_id` + policy RLS no mesmo padrão, senão ficam
  invisíveis (ou vazam) após a migração.

### 2. Canais — múltiplos números WhatsApp por org (Zernio + UAZAPI) 📱

- **Migrations**: `20260802100000_uazapi_provider.sql`,
  `20260802130000_conversation_provider.sql`,
  `20260811120000_channel_ai_enabled.sql`,
  `20260811130000_sender_type_owner.sql`.
- **O que fazem**: tabela `whatsapp_hub.channels` (N números por org;
  `provider 'zernio' | 'uazapi'`; token UAZAPI cifrado AES-GCM na linha;
  `webhook_secret`; `assigned_member`; `ai_enabled` default true);
  `conversations.channel_id` / `campaigns.channel_id` carimbam o número;
  `sender_type 'owner'` para mensagens enviadas pelo dono fora do CRM.
- **Backend**: `supabase/functions/_shared/channels.ts`
  (`getSendContextForConversation` resolve por qual número enviar),
  `_shared/uazapi.ts`, `_shared/inbox-delivery.ts`,
  `supabase/functions/uazapi-webhook/`, `api/uazapi-connect.ts`,
  `api/zernio-media.ts` (proxy autenticado de mídia).
- **Roteamento de webhooks**: Zernio por `?org=<uuid>` na URL (HMAC com secret
  da org); UAZAPI por `?secret=<channels.webhook_secret>`.
- **Frontend**: `src/app/routes/settings/sections/ChannelsSettings.tsx`
  (tela de Canais com resumo e seções por provedor), `src/lib/uazapi.ts`,
  `src/hooks/useWhatsappProvider.ts`, `src/hooks/useAiChannels.ts`, badge de
  provedor e badges Cliente/IA por canal no inbox.
- **Regras de negócio**:
  - IA por número: `channels.ai_enabled=false` → conversa nova nasce
    `human_active`+`ai_paused` (o flip dispara os triggers de handoff);
    `process-ai-message` também checa `ai_enabled` em conversas existentes.
  - Atribuição, nesta ordem: (1) `assigned_member` do número na chegada;
    (2) senão, round-robin da fila entre operadores online no handoff;
    manual nunca é sobrescrito.
  - UAZAPI não tem janela de 24h (envio livre); foto de perfil do lead só
    via UAZAPI (refresh 7 dias no webhook).

### 3. Distribuição de leads — round-robin só entre online 👥

- **Migration**: `20260802150100_round_robin_online.sql`.
- Round-robin da fila `lead_assignment_queue` considera apenas membros com
  `is_online = true`; funciona também com IA inativa.
- **Frontend**: `src/hooks/useLeadAssignmentQueue.ts`; em /settings, card de
  equipe explica a ordem real da distribuição e mostra total de conversas por
  membro.

### 4. Automações (módulo novo) ⚙️

- **Migrations**: `20260802150200_followup_rules_v2.sql`,
  `20260802150300_funnel_automations.sql`.
- **Backend**: `supabase/functions/funnel-automation/`.
- **Frontend**: `src/app/routes/automations/`, `src/components/automations/`.
- Automações de funil (gatilhos por etapa) + follow-up rules v2. Ações
  agendadas no CRM (`src/hooks/useScheduledActions.ts`,
  `src/components/crm/ProximaAcao.tsx` — "Próxima ação" disponível também
  para clientes com deal ganho).

### 5. Campanhas — variáveis por destinatário e segmentação por funil 📣

- Variáveis personalizadas por destinatário via `variableMapping` do Zernio;
  variáveis de negócio (título do deal, produtos, valor, última compra);
  fallback para o nome do contato.
- Segmentação de audiência por funil e etapa; mapa de canais UTM
  (`src/components/campaigns/UtmChannelMap.tsx`).
- Status real de entrega + motivo da falha por destinatário
  (migration `20260802190000_message_delivery_status.sql`); reconciliação de
  métricas de broadcast (casos de metrics zeradas).
- Arquivos principais: `src/components/campaigns/`, `supabase/functions/dispatch-campaign/`,
  `supabase/functions/zernio-webhook/`.

### 6. Inbox 💬

- Negócio ativo vinculado à conversa (migration
  `20260721120000_conversation_active_deal.sql`, se ainda não tiver);
  botões Ganho/Perdido na conversa; painel de contato recolhível.
- Separadores de data na thread (Hoje/Ontem/data); caixa de filtros no padrão
  do funil; filtro Lead/Cliente; mídia via proxy autenticado
  (`api/zernio-media.ts`); áudio do operador; correção de flicker/duplicação
  no envio; resolução correta da conversa no Zernio (Instagram + auto-heal);
  acesso por atribuição; fatiamento de filtros `.in()` em lotes de 100 ids.
- Arquivos principais: `src/components/inbox/`, `src/app/routes/inbox/`,
  `supabase/functions/send-operator-message/`, `send-operator-media/`.

### 7. Funil comercial 🎯

- Arquivar deals (migration `20260801190000_deals_archive.sql`), paginação
  por etapa, botão "+Negócio" no topo, filtros completos
  (`src/components/funil/FunilFilters.tsx`, `funilFilterLogic.ts`,
  `AddToPipelineModal.tsx`), sort por recente/valor/alfabética.
- Regra de temperatura por resultado (migration
  `20260801210000_temperature_won_lost.sql`): ganho → Morno; perdido → Lead
  Frio. Backfill de status won/lost divergentes
  (`20260720150000_backfill_won_lost_status.sql`).
- Valor por produto no card (`20260716120000_deal_products_value.sql` —
  `deal_products.value/quantity`).
- Produtos com tipos customizados e quantidade
  (`20260802150000_products_custom_types.sql`, `src/hooks/useProducts.ts`).

### 8. Dashboard 📊

- Filtros de período: Hoje, Ontem, Essa semana, Semana anterior (domingo como
  primeiro dia); série horária (00h–23h) no filtro Hoje; tooltips com
  quantidade e valor; botão Atualizar.
- Custos de venda e faturamento líquido (migration
  `20260805150000_sales_costs.sql`, `src/hooks/useSalesCosts.ts`,
  `src/lib/salesCosts.ts`): badge "Líquido" em Vendas ganhas quando há custos
  configurados.
- Permissões: operador não acessa Dashboard nem Funil (guard por role no
  router).

### 9. Agente de IA 🤖

- Entende áudio e imagem recebidos na conversa.
- Base de conhecimento mais robusta: extração de PDF com fallback via OpenAI,
  mensagens de erro reais no frontend (chave inválida/sem saldo etc.).
- Modelos GPT-5.x no seletor; OpenAI API Key nas configurações avançadas do
  agente; simplificação OpenAI-only (o seletor de provider de LLM foi
  removido — se o aluno usa Claude/Gemini no agente dele, tratar como
  "equivalente ou melhor" e manter).
- Arquivos: `supabase/functions/process-ai-message/`, `process-knowledge/`,
  `transcribe-audio/`, `src/app/routes/` (AIAgentPage).

### 10. UI/UX geral 🎨

- Responsividade mobile/tablet: tabelas viram cartões, toolbars corrigidas.
- Sidebar recolhível (seta flutuante no centro da borda).
- Avatares de membros; banner de credenciais faltantes
  (`src/components/CredentialsBanner.tsx`, `src/hooks/useMissingCredentials.ts`).
- Contatos: export CSV (e-mail, tags, só selecionados), filtro Lead/Cliente,
  seletor de linhas por página (25/50/100/1000).
- Settings reorganizado: aba Credenciais removida — conexões foram para
  Canais e a chave de LLM para o Agente de IA.

---

## Checklist pós-implementação

1. `npm run build` e `npm run validate:sql` passam sem erros.
2. `npm run db:push` aplicou as migrations novas (conferir em `schema_versions`
   / `_bootstrap_state` conforme o setup).
3. `npm run functions:deploy` deployou as Edge Functions novas/alteradas
   (destaque: `uazapi-webhook`, `funnel-automation`, e todas as que passaram a
   ler credencial por org).
4. Login funciona e os dados antigos aparecem na org `principal`
   (Organização Principal).
5. Webhook do Zernio reconfigurado com `?org=<uuid>` da org.
6. Em /settings → Canais: número(s) cadastrados como canal, com
   provider correto.
7. Fluxo ponta a ponta: mensagem inbound → conversa criada com `org_id` e
   `channel_id` → IA responde (ou handoff, se `ai_enabled=false`).
