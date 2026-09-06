-- Platform registry
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  db_schema TEXT NOT NULL UNIQUE,
  isolation_mode TEXT NOT NULL DEFAULT 'schema' CHECK (isolation_mode IN ('schema', 'dedicated')),
  gateway JSONB NOT NULL DEFAULT '{"allowedProviders":["openai","deepseek","anthropic"]}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
