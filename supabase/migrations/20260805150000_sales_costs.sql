-- ============================================================================
-- Faturamento líquido no dashboard: custos por venda configuráveis.
-- ----------------------------------------------------------------------------
-- sales_costs (jsonb) em app_settings (singleton, escrita admin-only via RLS):
--   { "checkout_pct": 4.99, "tax_pct": 6, "other_value": 2.5, "other_kind": "fixed" | "pct" }
-- O card "Vendas ganhas" abate esses custos do valor bruto do período.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS sales_costs jsonb NOT NULL DEFAULT '{}'::jsonb;
