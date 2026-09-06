CREATE TABLE IF NOT EXISTS :schema.sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.audit_log (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID,
  action TEXT NOT NULL,
  actor TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.golden_tasks (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL,
  input TEXT NOT NULL,
  expected_contains JSONB,
  max_latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.eval_traces (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  output TEXT NOT NULL,
  latency_ms INT NOT NULL,
  tool_calls JSONB,
  tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_traces_created ON :schema.eval_traces (created_at);
CREATE INDEX IF NOT EXISTS idx_eval_traces_profile ON :schema.eval_traces (profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS :schema.kb_documents (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_workspace ON :schema.kb_documents (workspace_id);
