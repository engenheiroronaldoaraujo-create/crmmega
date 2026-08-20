-- ============================================================================
-- 20260623123000_zernio_data_cleanup
-- ----------------------------------------------------------------------------
-- Ajustes de dados da migracao Meta → Zernio (Modulo 3). Os renames de id
-- externo (meta_message_id → zernio_message_id), as colunas zernio_* e a tabela
-- webhook_events ja vieram em 20260623120000 (Modulo 2). Aqui ficam os
-- ajustes restantes:
--
--   1. Tier manual removido. O tier deixa de ser um valor informado a mao e
--      passa a ser lido de GET /whatsapp/number-info, cacheado na credencial
--      `zernio_number_info` (public.app_settings). O ENUM whatsapp_hub.meta_tier
--      ficou orfao (sua unica coluna vivia em `tenants`, dropada no
--      20260430120002) — removido aqui.
--
--   2. Categoria de template: a Meta/Zernio so aceita MARKETING, UTILITY e
--      AUTHENTICATION. Adiciona 'authentication' ao enum. 'service' e mantido
--      por compatibilidade (linhas existentes) mas esta DEPRECADO — atendimento
--      livre nao e categoria de template, e sim resposta dentro da janela de
--      24h. A UI deixa de oferecer 'service' no Modulo 4; submit-template ja
--      mapeia service → UTILITY.
--
--   3. Resend: nao ha colunas de Resend no schema (as credenciais resend_api_key
--      / email_from viviam no KV public.app_settings e sairam do contrato no
--      Modulo 1). A remocao do USO de Resend (create-invite → convites nativos
--      do Supabase) fica para o Modulo 5.
--
-- Templates `components`: nao adicionamos coluna redundante. As colunas
-- estruturadas (header_type/header_content/body/footer/buttons/variables) ja
-- descrevem o template; submit-template e dispatch-campaign derivam os
-- components no formato Zernio/Meta, com as variaveis da campanha mapeadas para
-- `parameters` na ordem posicional (variable_mapping["1".."N"]).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Remove o ENUM de tier manual (orfao apos o drop da tabela tenants).
DROP TYPE IF EXISTS whatsapp_hub.meta_tier;

-- 2. Categoria AUTHENTICATION (forward-compat para o Modulo 4).
ALTER TYPE whatsapp_hub.template_category ADD VALUE IF NOT EXISTS 'authentication';
