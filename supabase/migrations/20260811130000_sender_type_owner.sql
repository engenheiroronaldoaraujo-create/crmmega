-- ============================================================================
-- 20260811130000_sender_type_owner
-- ----------------------------------------------------------------------------
-- Novo valor 'owner' no enum sender_type: mensagens que o DONO do número
-- envia direto pelo WhatsApp do celular (fora do CRM) chegam pelo webhook da
-- UAZAPI (fromMe=true, wasSentByApi=false) e são registradas como outbound
-- 'owner' na conversa — para aparecerem na inbox. Renderizadas como "WhatsApp".
-- (Zernio/Meta oficial não expõe esse eco em números API-hosted; só se aplica
-- à integração UAZAPI.)
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TYPE whatsapp_hub.sender_type ADD VALUE IF NOT EXISTS 'owner';
