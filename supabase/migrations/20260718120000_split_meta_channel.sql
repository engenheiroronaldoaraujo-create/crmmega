-- ============================================================================
-- Módulo 4 · Separar canal pago da Meta em Instagram Ads vs Facebook Ads
-- ----------------------------------------------------------------------------
-- Antes, todo tráfego pago de fb/ig/an/msg colapsava em `meta_ads`. A URL dos
-- anúncios usa utm_source={{site_source_name}}, que a Meta resolve para
-- fb | ig | an | msg. Para exibir a origem exata, a derivação passa a distinguir:
--   ig  → instagram_ads
--   fb  → facebook_ads
--   an/msg/meta (Audience Network, Messenger, genérico) → meta_ads
-- O mapa de alias (app_settings.utm_channel_map) resolve ig→instagram,
-- fb→facebook, an→meta, msg→meta antes desta escolha (dado de instância, fora
-- desta migration).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

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
    OR (canon IS NOT NULL AND canon IN ('meta','meta_ads','google_ads','tiktok_ads','linkedin_ads','facebook_ads','instagram_ads','ads'))
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
      WHEN canon IN ('instagram','instagram_ads') THEN 'instagram_ads'
      WHEN canon IN ('facebook','facebook_ads') THEN 'facebook_ads'
      WHEN canon IN ('meta','meta_ads') THEN 'meta_ads'
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
