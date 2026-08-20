-- Módulo 3: canal omnichannel (Instagram via Zernio) no inbox unificado.
SET search_path TO whatsapp_hub;

-- Canal da conversa: 'whatsapp' | 'instagram' | (futuro: 'email','webchat')
ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

-- Identidade Instagram do contato (IG-scoped id / username). Contatos WhatsApp
-- continuam identificados por phone; Instagram por instagram_id.
ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS instagram_id text;

-- Um contato Instagram por id (NULLs não colidem — contatos WhatsApp ficam livres).
CREATE UNIQUE INDEX IF NOT EXISTS contacts_instagram_id_key
  ON whatsapp_hub.contacts (instagram_id) WHERE instagram_id IS NOT NULL;

-- phone deixa de ser obrigatório para permitir contatos só-Instagram.
ALTER TABLE whatsapp_hub.contacts ALTER COLUMN phone DROP NOT NULL;

-- Índice para filtrar/contar conversas por canal no inbox.
CREATE INDEX IF NOT EXISTS conversations_channel_idx ON whatsapp_hub.conversations (channel);
