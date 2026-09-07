CREATE SCHEMA IF NOT EXISTS platform;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS platform.tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  db_schema TEXT NOT NULL,
  isolation_mode TEXT NOT NULL DEFAULT 'schema',
  gateway JSONB NOT NULL DEFAULT '{}',
  dedicated_database_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
