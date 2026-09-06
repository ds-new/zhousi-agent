CREATE TABLE IF NOT EXISTS :schema.workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.profiles (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES :schema.workspaces(id),
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  pinned_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.profile_versions (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES :schema.profiles(id),
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  approval_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, version)
);

CREATE TABLE IF NOT EXISTS :schema.sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES :schema.workspaces(id),
  profile_id UUID NOT NULL REFERENCES :schema.profiles(id),
  profile_version_id UUID NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.memory_entries (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES :schema.workspaces(id),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_session_id UUID,
  ttl TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_workspace ON :schema.memory_entries(workspace_id);

CREATE TABLE IF NOT EXISTS :schema.private_skills (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES :schema.workspaces(id),
  name TEXT NOT NULL,
  skill_md TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS :schema.kb_documents (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES :schema.workspaces(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_workspace ON :schema.kb_documents(workspace_id);

CREATE TABLE IF NOT EXISTS :schema.evolution_runs (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES :schema.profiles(id),
  base_version_id UUID NOT NULL,
  candidate_version_id UUID,
  tier TEXT NOT NULL,
  trigger TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  eval_score_delta FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
