-- ============================================================================
-- Module 1 · Knowledge Base, Knowledge Chunks, AI Agent Config
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- knowledge_base
-- ----------------------------------------------------------------------------
-- A "document" in the KB. Either a file in Storage (file_path) or a URL
-- (source_url). file_size_bytes is used to enforce the 30MB per-tenant quota.

CREATE TABLE whatsapp_hub.knowledge_base (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  type             whatsapp_hub.knowledge_type NOT NULL,
  source_url       TEXT,
  file_path        TEXT,
  file_size_bytes  INT NOT NULL DEFAULT 0,
  status           whatsapp_hub.knowledge_status NOT NULL DEFAULT 'processing',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_knowledge_base_updated_at
  BEFORE UPDATE ON whatsapp_hub.knowledge_base
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- knowledge_chunks
-- ----------------------------------------------------------------------------
-- 500-token chunks with 50-token overlap; embeddings from OpenAI
-- text-embedding-3-small (1536 dims).

CREATE TABLE whatsapp_hub.knowledge_chunks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id  UUID NOT NULL REFERENCES whatsapp_hub.knowledge_base(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  content            TEXT NOT NULL,
  embedding          vector(1536),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- ai_agent_config
-- ----------------------------------------------------------------------------
-- One row per tenant. Holds the system prompt and sampling params used by
-- process-ai-message. UNIQUE(tenant_id) so upserts target a single row.

CREATE TABLE whatsapp_hub.ai_agent_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL UNIQUE REFERENCES whatsapp_hub.tenants(id) ON DELETE CASCADE,
  system_prompt   TEXT,
  temperature     REAL NOT NULL DEFAULT 0.7,
  max_tokens      INT NOT NULL DEFAULT 1000,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_ai_agent_config_updated_at
  BEFORE UPDATE ON whatsapp_hub.ai_agent_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();
