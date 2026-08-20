-- Backfill: reconcilia deals cujo estado diverge entre funil e dashboard.
-- Duas origens do problema (ambas corrigidas no código):
--   1. Deal CRIADO direto em etapa de ganho/perda ficava com status 'open'
--      (o insert do frontend sempre gravava 'open').
--   2. Deal INSERIDO já como 'won' (via integrações) ficava sem won_at — o
--      trigger _sync_deal_outcome_ts só cobre UPDATE de status, não INSERT.
-- Em ambos os casos o funil mostrava o card em Ganho, mas o dashboard (que
-- conta por status + won_at no período) não enxergava a venda.
-- Idempotente: só toca linhas ainda divergentes.

SET search_path TO whatsapp_hub;

-- Caso 2: status já 'won'/'lost' mas sem timestamp (insert direto do webhook).
-- updated_at aproxima o momento da venda.
UPDATE deals SET won_at  = COALESCE(won_at,  updated_at, now()) WHERE status = 'won'  AND won_at  IS NULL;
UPDATE deals SET lost_at = COALESCE(lost_at, updated_at, now()) WHERE status = 'lost' AND lost_at IS NULL;

-- won_at/lost_at usam updated_at como aproximação de quando o deal chegou à
-- etapa (o trigger sync_won_lost_at preserva valores explícitos via COALESCE).
UPDATE deals d
SET status = 'won',
    won_at = COALESCE(d.won_at, d.updated_at, now())
FROM stages s
WHERE s.id = d.stage_id
  AND s.is_won
  AND d.status = 'open';

UPDATE deals d
SET status = 'lost',
    lost_at = COALESCE(d.lost_at, d.updated_at, now())
FROM stages s
WHERE s.id = d.stage_id
  AND s.is_lost
  AND d.status = 'open';
