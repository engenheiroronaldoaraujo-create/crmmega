-- Auto-add de leads ao funil por canal.
-- Quando um lead entra em contato por este número/canal pela primeira vez, o
-- webhook cria um deal no funil (pipeline) e etapa (stage) escolhidos. Desligado
-- por padrão; ao ligar, o usuário escolhe pipeline + stage na aba Canais.
ALTER TABLE whatsapp_hub.channels
  ADD COLUMN IF NOT EXISTS funnel_auto_add boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS funnel_pipeline_id uuid
    REFERENCES whatsapp_hub.pipelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funnel_stage_id uuid
    REFERENCES whatsapp_hub.stages(id) ON DELETE SET NULL;
