CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  db_schema TEXT NOT NULL,
  isolation_mode TEXT NOT NULL DEFAULT 'schema',
  gateway JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
