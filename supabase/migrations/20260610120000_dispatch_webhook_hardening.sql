-- ============================================================================
-- 20260610120000_dispatch_webhook_hardening
-- ----------------------------------------------------------------------------
-- Endurece o despacho de campanhas e a ingestão de webhooks contra três
-- problemas de concorrência/idempotência encontrados na auditoria de QA:
--
--   1. Despacho concorrente (cron 30s + tick lento) selecionava as MESMAS
--      linhas `pending` e disparava a mesma mensagem duas vezes à Meta.
--      Solução: `claim_campaign_contacts()` reserva linhas com
--      FOR UPDATE SKIP LOCKED + carimbo `claimed_at`, então dois ticks nunca
--      pegam a mesma linha. Linhas reservadas há mais de 2 min (tick que
--      morreu no meio) voltam a ser elegíveis — auto-recuperação.
--
--   2. Contadores agregados de campanha (sent/delivered/read/replied/failed)
--      eram lidos-e-reescritos no app (perda de updates concorrentes e
--      double-count em retries at-least-once da Meta). Solução:
--      `bump_campaign_counter()` faz UPDATE atômico col = col + delta.
--      O guard de transição de estado fica no caller (meta-webhook).
--
--   3. `unread_count` da conversa era fixado em 1 a cada inbound.
--      `increment_unread_count()` incrementa de forma atômica.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- Carimbo de reserva por linha. NULL = livre. Mantém o status em 'pending'
-- enquanto o tick processa (sem precisar de novo valor de enum, que não pode
-- ser adicionado dentro do multi-statement da Management API).
ALTER TABLE whatsapp_hub.campaign_contacts
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_claim
  ON whatsapp_hub.campaign_contacts (campaign_id, status, claimed_at);

-- Incremento atômico de contador agregado da campanha.
CREATE OR REPLACE FUNCTION whatsapp_hub.bump_campaign_counter(
  p_campaign_id uuid,
  p_column      text,
  p_delta       int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub
AS $$
BEGIN
  IF p_column NOT IN ('sent', 'delivered', 'read', 'replied', 'failed') THEN
    RAISE EXCEPTION 'invalid counter column %', p_column;
  END IF;
  EXECUTE format(
    'UPDATE whatsapp_hub.campaigns SET %I = GREATEST(COALESCE(%I, 0) + $1, 0) WHERE id = $2',
    p_column, p_column
  ) USING p_delta, p_campaign_id;
END;
$$;

-- Reserva atômica de até p_limit linhas pendentes de uma campanha.
-- FOR UPDATE SKIP LOCKED garante que ticks concorrentes peguem conjuntos
-- disjuntos; o filtro de claimed_at evita re-pegar uma linha já reservada
-- por outro tick nos últimos 2 minutos.
CREATE OR REPLACE FUNCTION whatsapp_hub.claim_campaign_contacts(
  p_campaign_id uuid,
  p_limit       int
) RETURNS SETOF whatsapp_hub.campaign_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub
AS $$
BEGIN
  RETURN QUERY
  UPDATE whatsapp_hub.campaign_contacts cc
     SET claimed_at = now()
   WHERE cc.id IN (
     SELECT id
       FROM whatsapp_hub.campaign_contacts
      WHERE campaign_id = p_campaign_id
        AND status = 'pending'
        AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
      ORDER BY created_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
   RETURNING cc.*;
END;
$$;

-- Incremento atômico do contador de não-lidas da conversa.
CREATE OR REPLACE FUNCTION whatsapp_hub.increment_unread_count(
  p_conversation_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = whatsapp_hub
AS $$
  UPDATE whatsapp_hub.conversations
     SET unread_count    = COALESCE(unread_count, 0) + 1,
         last_message_at = now()
   WHERE id = p_conversation_id;
$$;
