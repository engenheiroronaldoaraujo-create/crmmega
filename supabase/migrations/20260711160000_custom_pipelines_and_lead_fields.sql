-- Ajustes 2+4: funis personalizáveis + campos ricos do lead (deal).
-- Adaptado ao schema single-org whatsapp_hub (deal = lead; reusa catálogo tags).
SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.pipelines ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE whatsapp_hub.stages ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE whatsapp_hub.deals ADD COLUMN IF NOT EXISTS lead_type text NOT NULL DEFAULT 'Lead';
ALTER TABLE whatsapp_hub.deals ADD COLUMN IF NOT EXISTS temperature text NOT NULL DEFAULT 'Frio';
ALTER TABLE whatsapp_hub.deals ADD COLUMN IF NOT EXISTS last_purchase_at date;
DO $$ BEGIN
  ALTER TABLE whatsapp_hub.deals ADD CONSTRAINT deals_lead_type_chk CHECK (lead_type IN ('Lead','Cliente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE whatsapp_hub.deals ADD CONSTRAINT deals_temperature_chk CHECK (temperature IN ('Frio','Morno','Quente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS whatsapp_hub.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);
CREATE TABLE IF NOT EXISTS whatsapp_hub.deal_products (
  deal_id uuid NOT NULL REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES whatsapp_hub.products(id) ON DELETE CASCADE,
  PRIMARY KEY (deal_id, product_id)
);
CREATE INDEX IF NOT EXISTS deal_products_deal_idx ON whatsapp_hub.deal_products (deal_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.deal_tags (
  deal_id uuid NOT NULL REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES whatsapp_hub.tags(id) ON DELETE CASCADE,
  PRIMARY KEY (deal_id, tag_id)
);
CREATE INDEX IF NOT EXISTS deal_tags_deal_idx ON whatsapp_hub.deal_tags (deal_id);

ALTER TABLE whatsapp_hub.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.deal_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.deal_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_select ON whatsapp_hub.products FOR SELECT TO authenticated USING (true);
CREATE POLICY products_write ON whatsapp_hub.products FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));
CREATE POLICY deal_products_select ON whatsapp_hub.deal_products FOR SELECT TO authenticated USING (true);
CREATE POLICY deal_products_write ON whatsapp_hub.deal_products FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));
CREATE POLICY deal_tags_select ON whatsapp_hub.deal_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY deal_tags_write ON whatsapp_hub.deal_tags FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  whatsapp_hub.products, whatsapp_hub.deal_products, whatsapp_hub.deal_tags TO authenticated;

UPDATE whatsapp_hub.pipelines SET is_default = true
  WHERE kind = 'comercial' AND position = 0
  AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pipelines WHERE is_default);

ALTER TABLE whatsapp_hub.deal_products REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_hub.deal_tags REPLICA IDENTITY FULL;
