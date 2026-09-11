-- Run once as the customer database administrator before enabling internal KB.
-- The default schema is fixed deliberately; never substitute request-controlled identifiers.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_workspace ON public.kb_documents (workspace_id);
