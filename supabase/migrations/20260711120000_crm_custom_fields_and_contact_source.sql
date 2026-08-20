-- Módulo 1: campos customizáveis do card do funil + origem do contato.
-- Adaptado ao schema single-org whatsapp_hub (sem org_id; RLS por role).
SET search_path TO whatsapp_hub;

-- Origem do lead (whatsapp | instagram | import | manual). Serve M1 (exibir origem)
-- e M3 (marcar source='instagram').
ALTER TABLE whatsapp_hub.contacts ADD COLUMN IF NOT EXISTS source text;

-- Definição do campo (criado pelo admin, vale para todos os cards)
CREATE TABLE IF NOT EXISTS whatsapp_hub.custom_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('text','number','date','select','boolean')),
  options jsonb,
  required boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Valor por deal (o "lead" do funil neste schema)
CREATE TABLE IF NOT EXISTS whatsapp_hub.custom_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_field_id uuid NOT NULL REFERENCES whatsapp_hub.custom_fields(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (custom_field_id, deal_id)
);
CREATE INDEX IF NOT EXISTS custom_field_values_deal_idx ON whatsapp_hub.custom_field_values (deal_id);
CREATE INDEX IF NOT EXISTS custom_fields_position_idx ON whatsapp_hub.custom_fields (position);

-- RLS: definições — leitura authenticated, escrita admin. Valores — escrita admin/operator.
ALTER TABLE whatsapp_hub.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.custom_field_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY custom_fields_select ON whatsapp_hub.custom_fields
  FOR SELECT TO authenticated USING (true);
CREATE POLICY custom_fields_write ON whatsapp_hub.custom_fields
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY cfv_select ON whatsapp_hub.custom_field_values
  FOR SELECT TO authenticated USING (true);
CREATE POLICY cfv_write ON whatsapp_hub.custom_field_values
  FOR ALL TO authenticated
  USING (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  whatsapp_hub.custom_fields, whatsapp_hub.custom_field_values TO authenticated;

-- Realtime
ALTER TABLE whatsapp_hub.custom_fields REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_hub.custom_field_values REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.custom_fields;
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.custom_field_values;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
