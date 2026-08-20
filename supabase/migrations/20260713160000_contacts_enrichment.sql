-- ============================================================================
-- Módulo 5 · Tela de Contatos enriquecida
-- ----------------------------------------------------------------------------
-- Adaptado ao schema real (sem org_id). Adiciona:
--   1. contacts.first_seen_at — data do primeiro registro (coluna da lista).
--   2. contact_channel_links — vínculo IG ↔ WhatsApp do mesmo contato.
--   3. contact_interactions + interaction_notes — timeline por interação
--      (data) com notas datadas por autor.
-- (Canal = contacts.source, já existente; Origem = traffic_type do deal.)
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- 1. Data do primeiro registro ----------------------------------------------
ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Backfill: contatos existentes herdam o created_at como primeiro registro.
UPDATE whatsapp_hub.contacts SET first_seen_at = created_at
 WHERE first_seen_at > created_at;
CREATE INDEX IF NOT EXISTS idx_contacts_first_seen ON whatsapp_hub.contacts(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_source ON whatsapp_hub.contacts(source);

-- 2. Vínculo de identidades de canal (IG ↔ WhatsApp) ------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.contact_channel_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram')),
  channel_identifier TEXT NOT NULL,   -- número E.164 ou @username / ig_id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, channel_identifier)
);
CREATE INDEX IF NOT EXISTS idx_channel_links_contact ON whatsapp_hub.contact_channel_links(contact_id);

ALTER TABLE whatsapp_hub.contact_channel_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_channel_links_read ON whatsapp_hub.contact_channel_links;
CREATE POLICY contact_channel_links_read ON whatsapp_hub.contact_channel_links
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS contact_channel_links_write ON whatsapp_hub.contact_channel_links;
CREATE POLICY contact_channel_links_write ON whatsapp_hub.contact_channel_links
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin', 'operator'));

-- 3. Interações (timeline por data) + notas ---------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.contact_interactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  interaction_date DATE NOT NULL,
  channel          TEXT,             -- whatsapp | instagram | sistema
  summary          TEXT,             -- ex.: "8 mensagens trocadas"
  event_type       TEXT,             -- conversa | mudanca_estagio | ganho | perdido | nota
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_contact
  ON whatsapp_hub.contact_interactions(contact_id, interaction_date DESC);

ALTER TABLE whatsapp_hub.contact_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_interactions_read ON whatsapp_hub.contact_interactions;
CREATE POLICY contact_interactions_read ON whatsapp_hub.contact_interactions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS contact_interactions_write ON whatsapp_hub.contact_interactions;
CREATE POLICY contact_interactions_write ON whatsapp_hub.contact_interactions
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin', 'operator'));

CREATE TABLE IF NOT EXISTS whatsapp_hub.interaction_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID NOT NULL REFERENCES whatsapp_hub.contact_interactions(id) ON DELETE CASCADE,
  author_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interaction_notes_interaction
  ON whatsapp_hub.interaction_notes(interaction_id, created_at);

ALTER TABLE whatsapp_hub.interaction_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_notes_read ON whatsapp_hub.interaction_notes;
CREATE POLICY interaction_notes_read ON whatsapp_hub.interaction_notes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS interaction_notes_write ON whatsapp_hub.interaction_notes;
CREATE POLICY interaction_notes_write ON whatsapp_hub.interaction_notes
  FOR ALL TO authenticated
  USING      (whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (whatsapp_hub.current_user_role() IN ('admin', 'operator'));
