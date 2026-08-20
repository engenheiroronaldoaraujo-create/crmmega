-- ============================================================================
-- Módulo 4 · Rastreio de origem via UTMs + gerador de URLs
-- ----------------------------------------------------------------------------
-- Adaptado ao schema real: o "lead" é whatsapp_hub.deals; não há org_id
-- (instância mono-org). Adiciona:
--   1. Colunas utm_* + traffic_type + origin_channel em deals.
--   2. Mapa de canal editável (alias de utm_source) em app_settings.
--   3. Trigger de derivação server-side (traffic_type + origin_channel).
--   4. Tabela utm_links (histórico do gerador de URLs).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Colunas UTM + classificação derivada -----------------------------------
ALTER TABLE whatsapp_hub.deals
  ADD COLUMN IF NOT EXISTS utm_source     TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium     TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign   TEXT,
  ADD COLUMN IF NOT EXISTS utm_content    TEXT,
  ADD COLUMN IF NOT EXISTS utm_term       TEXT,
  ADD COLUMN IF NOT EXISTS traffic_type   TEXT,   -- 'organico' | 'pago' | 'manual'
  ADD COLUMN IF NOT EXISTS origin_channel TEXT;   -- google | instagram | meta_ads | ...

-- Índices para os widgets de origem do Dashboard (Módulo 3).
CREATE INDEX IF NOT EXISTS idx_deals_traffic_type   ON whatsapp_hub.deals(traffic_type);
CREATE INDEX IF NOT EXISTS idx_deals_origin_channel ON whatsapp_hub.deals(origin_channel);
CREATE INDEX IF NOT EXISTS idx_deals_utm_campaign   ON whatsapp_hub.deals(utm_campaign);

-- 2. Mapa de canal editável (alias de utm_source → token canônico) -----------
-- Ex.: { "ig": "instagram", "fb": "facebook", "gads": "google" }. A derivação
-- normaliza o utm_source por este mapa antes de escolher o canal. Editável em
-- Configurações → aba UTMs.
ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS utm_channel_map JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Função + trigger de derivação ------------------------------------------
-- Regras (spec Módulo 4.1):
--   traffic_type: medium pago (cpc/paid/paid_social/ppc/*paid*) ou source de
--     plataforma de ads → 'pago'; com UTM mas não-pago → 'organico'; sem UTM →
--     mantém o traffic_type informado (ex.: import='manual') ou 'manual'.
--   origin_channel: normaliza source pelo mapa e escolhe o canal conforme
--     pago/orgânico. Sem source → NULL (entrada manual sem rastreio).
CREATE OR REPLACE FUNCTION whatsapp_hub._derive_deal_traffic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  src   TEXT := NULLIF(btrim(lower(NEW.utm_source)), '');
  med   TEXT := NULLIF(btrim(lower(NEW.utm_medium)), '');
  cmap  JSONB;
  canon TEXT;
  is_paid BOOLEAN;
BEGIN
  SELECT utm_channel_map INTO cmap FROM whatsapp_hub.app_settings WHERE id = 1;
  cmap := COALESCE(cmap, '{}'::jsonb);

  -- source canônico pelo mapa de alias (fallback: o próprio source).
  canon := CASE WHEN src IS NULL THEN NULL
                ELSE COALESCE(NULLIF(btrim(lower(cmap->>src)), ''), src) END;

  -- pago?
  is_paid :=
    (med IS NOT NULL AND (med IN ('cpc','paid','paid_social','ppc','cpm','display') OR med LIKE '%paid%'))
    OR (canon IS NOT NULL AND canon IN ('meta_ads','google_ads','tiktok_ads','linkedin_ads','facebook_ads','instagram_ads','ads'))
    OR (canon IS NOT NULL AND canon LIKE '%_ads');

  -- traffic_type
  IF is_paid THEN
    NEW.traffic_type := 'pago';
  ELSIF src IS NOT NULL OR med IS NOT NULL OR NEW.utm_campaign IS NOT NULL THEN
    NEW.traffic_type := 'organico';
  ELSE
    NEW.traffic_type := COALESCE(NULLIF(btrim(lower(NEW.traffic_type)), ''), 'manual');
  END IF;

  -- origin_channel
  IF canon IS NULL THEN
    NEW.origin_channel := NULL;
  ELSIF NEW.traffic_type = 'pago' THEN
    NEW.origin_channel := CASE
      WHEN canon IN ('facebook','instagram','meta','meta_ads','facebook_ads','instagram_ads') THEN 'meta_ads'
      WHEN canon IN ('google','google_ads') THEN 'google_ads'
      WHEN canon IN ('tiktok','tiktok_ads') THEN 'tiktok_ads'
      WHEN canon IN ('linkedin','linkedin_ads') THEN 'linkedin_ads'
      WHEN canon IN ('youtube','youtube_ads') THEN 'youtube'
      ELSE 'outro'
    END;
  ELSE
    NEW.origin_channel := CASE
      WHEN canon = 'google' THEN 'google'
      WHEN canon = 'instagram' THEN 'instagram'
      WHEN canon = 'facebook' THEN 'facebook'
      WHEN canon = 'tiktok' THEN 'tiktok'
      WHEN canon = 'linkedin' THEN 'linkedin'
      WHEN canon = 'youtube' THEN 'youtube'
      ELSE 'outro'
    END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_derive_traffic ON whatsapp_hub.deals;
CREATE TRIGGER trg_deals_derive_traffic
  BEFORE INSERT OR UPDATE OF utm_source, utm_medium, utm_campaign, utm_content, utm_term, traffic_type
  ON whatsapp_hub.deals
  FOR EACH ROW
  EXECUTE FUNCTION whatsapp_hub._derive_deal_traffic();

-- 4. Histórico de URLs geradas ----------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.utm_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_url     TEXT NOT NULL,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  final_url    TEXT NOT NULL,
  label        TEXT,
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utm_links_created ON whatsapp_hub.utm_links(created_at DESC);

ALTER TABLE whatsapp_hub.utm_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utm_links_read ON whatsapp_hub.utm_links;
CREATE POLICY utm_links_read ON whatsapp_hub.utm_links
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS utm_links_write ON whatsapp_hub.utm_links;
CREATE POLICY utm_links_write ON whatsapp_hub.utm_links
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin','operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin','operator'));
