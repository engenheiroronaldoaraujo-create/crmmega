-- Módulo 2: histórico de vendas (upload Excel) + predição de recompra.
-- Adaptado ao schema single-org whatsapp_hub (sem org_id; RLS por role).
SET search_path TO whatsapp_hub;

CREATE TABLE IF NOT EXISTS whatsapp_hub.sales_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_doc text,
  customer_name text,
  customer_phone text,
  product_name text NOT NULL,
  quantity numeric NOT NULL,
  amount numeric,
  purchase_date date NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  source_file text,
  UNIQUE (customer_doc, product_name, purchase_date)  -- dedupe idempotente
);
CREATE INDEX IF NOT EXISTS sales_records_match_idx
  ON whatsapp_hub.sales_records (customer_doc, product_name, purchase_date);
CREATE INDEX IF NOT EXISTS sales_records_purchase_date_idx
  ON whatsapp_hub.sales_records (purchase_date);

CREATE TABLE IF NOT EXISTS whatsapp_hub.repurchase_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_doc text NOT NULL,
  customer_phone text NOT NULL,
  customer_name text,
  product_name text NOT NULL,
  avg_interval_days int NOT NULL,
  purchase_count int NOT NULL,
  last_purchase date NOT NULL,
  predicted_next date NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | sent | converted | snoozed
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_doc, product_name)
);
CREATE INDEX IF NOT EXISTS repurchase_predictions_next_idx
  ON whatsapp_hub.repurchase_predictions (predicted_next, status);

CREATE TABLE IF NOT EXISTS whatsapp_hub.repurchase_config (
  id int PRIMARY KEY DEFAULT 1,
  auto_send boolean NOT NULL DEFAULT false,      -- KILL-SWITCH (off até validar)
  lead_days int NOT NULL DEFAULT 3,
  cooldown_days int NOT NULL DEFAULT 14,
  min_purchases int NOT NULL DEFAULT 3,
  active_window_days int NOT NULL DEFAULT 90,
  template_name text,
  template_language text NOT NULL DEFAULT 'pt_BR',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repurchase_config_singleton CHECK (id = 1)
);
INSERT INTO whatsapp_hub.repurchase_config (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE whatsapp_hub.sales_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.repurchase_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.repurchase_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY sales_records_select ON whatsapp_hub.sales_records
  FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_records_write ON whatsapp_hub.sales_records
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY repredict_select ON whatsapp_hub.repurchase_predictions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY repredict_write ON whatsapp_hub.repurchase_predictions
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

CREATE POLICY reconfig_select ON whatsapp_hub.repurchase_config
  FOR SELECT TO authenticated USING (true);
CREATE POLICY reconfig_write ON whatsapp_hub.repurchase_config
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON
  whatsapp_hub.sales_records, whatsapp_hub.repurchase_predictions, whatsapp_hub.repurchase_config
TO authenticated;
