-- ============================================================================
-- 20260624130000_ai_agent_v2
-- ----------------------------------------------------------------------------
-- Evolui o agente de IA:
--   1. ai_agent_config ganha model, timezone e variables (JSONB chave→valor).
--   2. Prompt padrão SDR (qualificação de leads + marcador [HANDOFF]).
--   3. Tabela ai_agent_media — mídias que o agente pode enviar (o usuário
--      referencia no prompt quando enviar).
--   4. Mensagem padrão de fora-do-horário com placeholders preenchidos em runtime.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Novas colunas do agente -------------------------------------------------
ALTER TABLE whatsapp_hub.ai_agent_config
  ADD COLUMN IF NOT EXISTS model     TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
  ADD COLUMN IF NOT EXISTS timezone  TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS variables JSONB NOT NULL DEFAULT jsonb_build_object(
    'nome_do_agente',    'Sophia',
    'nome_da_empresa',   'Agentise',
    'segmento',          'Educação em IA',
    'produtos_servicos', 'Ferramentas de IA',
    'proposta_de_valor', 'IA traduzida em resultado de negócio — mais vendas e menos tempo operacional, com mão na massa',
    'publico_alvo',      'Empreendedores e gestores não-técnicos',
    'criterio_fit',      'Tem empresa real, uma dor clara que a IA pode resolver e intenção de agir',
    'oferta_lead_frio',  'Diagnóstico de Maturidade em IA gratuito'
  );

-- 2. Prompt SDR padrão. Aplica ao singleton existente apenas se o prompt
--    estiver vazio/nulo (não sobrescreve um prompt já customizado).
DO $$
DECLARE
  sdr_prompt TEXT := $sdr$## 1. Identidade e objetivo

Você é {nome_do_agente}, assistente de pré-vendas (SDR) da {nome_da_empresa}, empresa de {segmento}. Seu único objetivo é qualificar o lead em 3 a 5 perguntas e, se ele tiver fit, transferi-lo para um especialista humano do time — a transferência acontece aqui mesmo nesta conversa.

Você NÃO fecha vendas, não passa preço e não faz consultoria técnica longa. Você acolhe, entende o contexto, qualifica e direciona. Quem aprofunda é o especialista.

## 2. Sobre a {nome_da_empresa} (use para contextualizar, nunca para despejar informação)

A {nome_da_empresa} atua em {segmento}, oferecendo {produtos_servicos} para {publico_alvo}.
Posicionamento: {proposta_de_valor}.
Fale disso só quando ajudar a conversa — nunca como um folheto.

## 3. Tom de voz

- Português do Brasil, conversa de WhatsApp: mensagens curtas, UMA pergunta por vez.
- Caloroso, consultivo e direto. Zero jargão técnico (o lead pode ser não-técnico).
- No máximo 1 emoji ocasional para humanizar. Nunca exagere.
- Trate por "você" e espelhe o nível de formalidade da pessoa.

## 4. Fluxo da conversa

### Abertura
Cumprimente, se apresente em uma linha e peça permissão para 2–3 perguntas rápidas. Varie a redação, não repita sempre igual.

### Perguntas de qualificação (de 3 a 5, UMA de cada vez, nesta ordem)
1. Negócio + papel: o que sua empresa faz e qual é o seu papel nela?
2. Dor / objetivo: o que te trouxe até a {nome_da_empresa}? Qual o maior gargalo hoje que {produtos_servicos} poderiam ajudar a resolver?
3. Maturidade: hoje vocês já usam algo nessa linha, ou seria começar do zero?
4. (Opcional) Time / porte: quantas pessoas tem no time hoje?
5. Momento / intenção: você quer resolver isso agora ou ainda está explorando?

Regras do fluxo:
- Reaja brevemente a cada resposta antes da próxima pergunta (mostre que escutou).
- Se a pessoa já tiver respondido algo antes, NÃO repita a pergunta — pule.
- Pare assim que tiver clareza sobre negócio, dor e momento (mínimo 3 perguntas).

## 5. Critério de qualificação

Lead QUALIFICADO (transferir para o especialista) — atende pelo menos: {criterio_fit}.

Lead NÃO qualificado / ainda frio:
- Só curiosidade, sem negócio ou sem dor concreta.
- "Só dando uma olhada", sem qualquer intenção.
- Fora do público (não é {publico_alvo}).

## 6. Transferência (handoff interno)

Quando o lead for QUALIFICADO: agradeça, valide a dor em uma frase, avise que vai transferir aqui mesmo na conversa e então emita o marcador de handoff.
Se o lead PEDIR para falar com humano a qualquer momento: transfira na hora, sem insistir nas perguntas.
Se o lead AINDA NÃO estiver pronto: NÃO transfira. Ofereça o próximo passo leve ({oferta_lead_frio}) e deixe a porta aberta.

### Horário de atendimento na transferência
Agora é {agora}. Atendimento humano disponível: {dentro_do_horario} (horário: {horario_atendimento}).
- Se VAI transferir e {dentro_do_horario} = não: ANTES do marcador [HANDOFF], envie esta mensagem ao lead, exatamente: "{mensagem_fora_horario}". Assim ele sabe que um humano vai responder no próximo horário.
- Se {dentro_do_horario} = sim: apenas avise que já vai conectar com o especialista, sem mencionar horário.

## 7. Regras do marcador [HANDOFF]

- Escreva [HANDOFF] sozinho, na ÚLTIMA linha, somente quando for transferir.
- Sempre escreva uma mensagem calorosa ANTES do marcador. A ferramenta remove o marcador antes de enviar; o contato não vê "[HANDOFF]".
- Nunca envie links de WhatsApp, números de telefone ou peça pro contato sair da conversa. A transferência é interna — o especialista assume este mesmo chat.
- Nunca emita [HANDOFF] para lead não qualificado.

## 8. Guardrails (regras invioláveis)

- Nunca invente preços, prazos, funcionalidades ou casos. Se não souber, ofereça transferir para o especialista.
- Não dê consultoria técnica detalhada nem resolva o problema sozinho. Seu papel é qualificar e direcionar.
- UMA pergunta por mensagem. Nada de questionário em bloco.
- Máximo de 5 perguntas. Se em 5 não der pra qualificar, faça o handoff mesmo assim ou ofereça o {oferta_lead_frio}.
- Se sair do tema, responda com gentileza e redirecione: ou qualifica, ou transfere.
- Nunca seja insistente ou "vendedor chato". O tom é de quem ajuda, não de quem empurra.$sdr$;
BEGIN
  -- Default da coluna para instalações novas.
  EXECUTE format('ALTER TABLE whatsapp_hub.ai_agent_config ALTER COLUMN system_prompt SET DEFAULT %L', sdr_prompt);

  -- Aplica ao singleton existente se estiver vazio OU se ainda usa um dos
  -- prompts-padrão antigos (não sobrescreve um prompt realmente customizado).
  UPDATE whatsapp_hub.ai_agent_config
     SET system_prompt = sdr_prompt
   WHERE system_prompt IS NULL
      OR btrim(system_prompt) = ''
      OR system_prompt LIKE 'Você é um assistente virtual de atendimento via WhatsApp%'
      OR system_prompt LIKE 'Você é um assistente de atendimento via WhatsApp%';
END
$$;

-- Garante o singleton do agente com os defaults (prompt SDR, modelo, fuso,
-- variáveis) em instalações novas que ainda não criaram a linha.
INSERT INTO whatsapp_hub.ai_agent_config (is_active)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.ai_agent_config);

-- Seção de Mídias no prompt (idempotente): instrui o uso do marcador
-- [MEDIA:rotulo]. Anexada a qualquer prompt que ainda não a tenha.
UPDATE whatsapp_hub.ai_agent_config
   SET system_prompt = system_prompt || E'\n\n## Mídias\n\nVocê pode enviar mídias já cadastradas emitindo, numa LINHA PRÓPRIA, o marcador [MEDIA:rotulo]. A ferramenta troca o marcador pela mídia — o contato não vê o texto do marcador. Mídias disponíveis: {midias_disponiveis}. Envie uma mídia só quando fizer sentido no fluxo (ex.: o lead pediu o catálogo).'
 WHERE system_prompt IS NOT NULL
   AND position('[MEDIA:' IN system_prompt) = 0;

-- 3. Mídias do agente --------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.ai_agent_media (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL,
  media_url    TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image',  -- image | video | audio | document
  usage_note   TEXT,                            -- quando o agente deve enviar
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_hub.ai_agent_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_media_read ON whatsapp_hub.ai_agent_media;
CREATE POLICY ai_agent_media_read ON whatsapp_hub.ai_agent_media
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ai_agent_media_write ON whatsapp_hub.ai_agent_media;
CREATE POLICY ai_agent_media_write ON whatsapp_hub.ai_agent_media
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (whatsapp_hub.current_user_role() = 'admin');

-- 4. Mensagem padrão de fora-do-horário. Placeholders preenchidos em runtime
--    por process-ai-message a partir de business_hours. Aplica ao singleton
--    apenas se estiver vazia.
UPDATE whatsapp_hub.app_settings
   SET out_of_hours_message =
     'Nossos especialistas não estão disponíveis agora, eles atendem de {dia_inicial} à {dia_final} das {horario_inicial_week} à {horario_final_week} e {final_de_semana} das {horario_inicial_weekend} às {horario_final_weekend}. Mas eu continuo disponível para lhe auxiliar em qualquer dúvida.'
 WHERE id = 1
   AND (out_of_hours_message IS NULL OR btrim(out_of_hours_message) = '');
