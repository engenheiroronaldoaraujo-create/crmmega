-- ============================================================================
-- Module 1 · Indexes
-- ============================================================================
-- Mandatory indexes (from CLAUDE.md) + practical supporting indexes for the
-- dispatch worker, inbox realtime, and notification tray.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ---- Required by CLAUDE.md ------------------------------------------------

CREATE INDEX idx_contacts_tenant_phone
  ON whatsapp_hub.contacts(tenant_id, phone);

CREATE INDEX idx_messages_conversation
  ON whatsapp_hub.messages(conversation_id, created_at);

CREATE INDEX idx_campaign_contacts_status
  ON whatsapp_hub.campaign_contacts(campaign_id, status);

-- ivfflat requires lists; 100 is a reasonable starting point. Tune with ANALYZE
-- once there is real data volume. Re-run REINDEX CONCURRENTLY if the list
-- count is adjusted later.
CREATE INDEX idx_knowledge_chunks_embedding
  ON whatsapp_hub.knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX idx_conversations_tenant_status
  ON whatsapp_hub.conversations(tenant_id, status);

-- ---- Supporting indexes ---------------------------------------------------

-- member lookups on login / online presence
CREATE INDEX idx_tenant_members_user
  ON whatsapp_hub.tenant_members(user_id);
CREATE INDEX idx_tenant_members_tenant_online
  ON whatsapp_hub.tenant_members(tenant_id, is_online);

-- dispatch worker scans: "give me the next N pending rows"
CREATE INDEX idx_campaign_contacts_pending
  ON whatsapp_hub.campaign_contacts(tenant_id, created_at)
  WHERE status = 'pending';

-- follow-up worker: "which sent messages have no reply and are past the delay?"
CREATE INDEX idx_campaign_contacts_sent_no_reply
  ON whatsapp_hub.campaign_contacts(sent_at)
  WHERE status IN ('sent','delivered','read');

-- webhook updates hit campaign_contacts by meta_message_id
CREATE INDEX idx_campaign_contacts_meta_msg
  ON whatsapp_hub.campaign_contacts(meta_message_id)
  WHERE meta_message_id IS NOT NULL;

-- webhook updates on messages table
CREATE INDEX idx_messages_meta_msg
  ON whatsapp_hub.messages(meta_message_id)
  WHERE meta_message_id IS NOT NULL;

-- inbox: messages grouped by tenant for auditing / realtime filter-by-tenant
CREATE INDEX idx_messages_tenant_created
  ON whatsapp_hub.messages(tenant_id, created_at);

-- inbox filters: assigned operator
CREATE INDEX idx_conversations_assigned
  ON whatsapp_hub.conversations(tenant_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

-- conversation list ordering (most recent on top)
CREATE INDEX idx_conversations_tenant_last_msg
  ON whatsapp_hub.conversations(tenant_id, last_message_at DESC NULLS LAST);

-- notification tray: unread, per user
CREATE INDEX idx_notifications_user_unread
  ON whatsapp_hub.notifications(user_id, created_at DESC)
  WHERE is_read = false;

-- knowledge chunks scoped by tenant (RLS planner hint + similarity pre-filter)
CREATE INDEX idx_knowledge_chunks_tenant
  ON whatsapp_hub.knowledge_chunks(tenant_id);

-- knowledge_base listing
CREATE INDEX idx_knowledge_base_tenant_status
  ON whatsapp_hub.knowledge_base(tenant_id, status);

-- templates listing by status (draft/pending/approved)
CREATE INDEX idx_templates_tenant_status
  ON whatsapp_hub.templates(tenant_id, status);

-- template polling: find pending templates for the status cron
CREATE INDEX idx_templates_pending_meta
  ON whatsapp_hub.templates(meta_template_id)
  WHERE status = 'pending' AND meta_template_id IS NOT NULL;

-- follow-up rule lookups
CREATE INDEX idx_follow_up_rules_tenant_active
  ON whatsapp_hub.follow_up_rules(tenant_id, is_active)
  WHERE is_active = true;

-- campaign_contacts dashboard queries
CREATE INDEX idx_campaign_contacts_contact
  ON whatsapp_hub.campaign_contacts(contact_id);

-- tag filtering for audience selection
CREATE INDEX idx_contact_tags_tag
  ON whatsapp_hub.contact_tags(tag_id);
CREATE INDEX idx_contact_tags_tenant
  ON whatsapp_hub.contact_tags(tenant_id);
