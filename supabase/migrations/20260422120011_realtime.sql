-- ============================================================================
-- Module 1 · Realtime publications
-- ============================================================================
-- Supabase Realtime broadcasts changes from tables that are members of the
-- `supabase_realtime` publication. Add the tables that drive live UI:
--
--   · conversations / messages     → inbox live updates
--   · notifications                → notification tray
--   · campaigns / campaign_contacts → live campaign progress bars
--
-- RLS still applies on the subscribing client, so a user only receives
-- changes for rows they are allowed to see.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.campaigns;
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.campaign_contacts;
