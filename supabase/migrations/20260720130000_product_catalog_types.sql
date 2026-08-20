-- Catálogo de produtos gerenciável em Configurações → Produtos.
-- `product_type` classifica o produto (curso, mentoria, consultoria, ebook,
-- app, ia, fisico). `quantity` é o estoque/quantidade e só faz sentido para
-- produtos físicos — o CHECK garante NULL nos demais tipos.
SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.products
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'curso';
ALTER TABLE whatsapp_hub.products
  ADD COLUMN IF NOT EXISTS quantity integer;

DO $$ BEGIN
  ALTER TABLE whatsapp_hub.products ADD CONSTRAINT products_type_chk
    CHECK (product_type IN ('curso','mentoria','consultoria','ebook','app','ia','fisico'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE whatsapp_hub.products ADD CONSTRAINT products_quantity_chk
    CHECK (quantity IS NULL OR (product_type = 'fisico' AND quantity >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
