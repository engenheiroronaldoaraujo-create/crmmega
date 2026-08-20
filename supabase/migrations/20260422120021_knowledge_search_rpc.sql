-- ============================================================================
-- Module 9 · RPC: tenant-scoped similarity search against knowledge_chunks
-- ============================================================================
-- process-ai-message calls this to retrieve the top-K most relevant chunks
-- for an inbound message. The RPC takes the query embedding (vector(1536))
-- and returns content + cosine similarity. Tenant isolation is enforced
-- inside the function body so the caller (service_role) still gets only the
-- right tenant's rows.
--
-- The ivfflat index on knowledge_chunks.embedding makes this O(log N).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE OR REPLACE FUNCTION whatsapp_hub.knowledge_search(
  p_tenant_id       UUID,
  p_query_embedding vector(1536),
  p_top_k           INT DEFAULT 5
)
RETURNS TABLE (
  id                UUID,
  knowledge_base_id UUID,
  content           TEXT,
  similarity        REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.knowledge_base_id,
    kc.content,
    (1 - (kc.embedding <=> p_query_embedding))::real AS similarity
  FROM whatsapp_hub.knowledge_chunks kc
  WHERE kc.tenant_id = p_tenant_id
    AND kc.embedding IS NOT NULL
  ORDER BY kc.embedding <=> p_query_embedding
  LIMIT GREATEST(1, LEAST(p_top_k, 50));
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(UUID, vector, INT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.knowledge_search(UUID, vector, INT) TO authenticated, service_role;
