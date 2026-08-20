-- ============================================================================
-- Produtos: tipos personalizados + descrição
-- ----------------------------------------------------------------------------
-- O catálogo deixa de ter tipos fixos (curso/mentoria/...) — o usuário pode
-- criar classes próprias (ex.: "imovel"). Quantidade passa a ser opcional para
-- qualquer tipo. Nova coluna description (exibida no catálogo e no funil).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.products DROP CONSTRAINT IF EXISTS products_type_chk;
ALTER TABLE whatsapp_hub.products DROP CONSTRAINT IF EXISTS products_quantity_chk;
ALTER TABLE whatsapp_hub.products
  ADD CONSTRAINT products_quantity_chk CHECK (quantity IS NULL OR quantity >= 0);

ALTER TABLE whatsapp_hub.products
  ADD COLUMN IF NOT EXISTS description TEXT;
