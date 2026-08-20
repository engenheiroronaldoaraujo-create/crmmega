-- ============================================================================
-- Valor por produto no card do funil
-- ----------------------------------------------------------------------------
-- Para exibir "produto — R$ valor" no card do deal, `deal_products` ganha
-- value + quantity. Preenchidos na venda (deal ganho) ou manualmente; adição
-- manual fica com value null.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Valor + quantidade por linha de produto do deal ---------------------------
ALTER TABLE whatsapp_hub.deal_products
  ADD COLUMN IF NOT EXISTS value    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS quantity NUMERIC NOT NULL DEFAULT 1;

-- Realtime do card: value/quantity já entram via a publicação existente de
-- deal_products (REPLICA IDENTITY FULL definida na migration de campos ricos).
