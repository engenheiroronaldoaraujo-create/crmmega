-- ============================================================================
-- Backfill de whatsapp_hub.stages.probability
-- ----------------------------------------------------------------------------
-- A migração 20260713140000 adicionou `probability INT NOT NULL DEFAULT 0`, de
-- modo que todos os estágios de funis já existentes ficaram em 0% — zerando o
-- forecast do dashboard (Σ valor × probabilidade dos negócios abertos).
--
-- Este backfill dá valores sensatos APENAS onde probability ainda é 0 (nunca
-- sobrescreve o que o usuário já configurou):
--   * estágios de ganho (is_won)  -> 100%
--   * estágios abertos            -> distribuídos linearmente por posição
--                                    dentro do funil (ex.: 3 abertos = 25/50/75)
--   * estágios de perda (is_lost) -> permanecem 0%
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- Ganhos que ficaram em 0 -> 100%.
UPDATE whatsapp_hub.stages
   SET probability = 100
 WHERE is_won = true AND probability = 0;

-- Abertos em 0 -> rampa por posição (evita 0 e 100 nas pontas).
WITH open_stages AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY pipeline_id ORDER BY position) AS rn,
         COUNT(*)     OVER (PARTITION BY pipeline_id)                    AS cnt
    FROM whatsapp_hub.stages
   WHERE is_won = false AND is_lost = false AND probability = 0
)
UPDATE whatsapp_hub.stages s
   SET probability = GREATEST(5, LEAST(95, ROUND((os.rn::numeric / (os.cnt + 1)) * 100)))
  FROM open_stages os
 WHERE s.id = os.id;
