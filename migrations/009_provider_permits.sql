-- Repair databases that recorded 008_operational_execution.sql before the
-- shared-concurrency permit table was added during v0.2 development.
CREATE TABLE IF NOT EXISTS provider_permits (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at)
);

CREATE INDEX IF NOT EXISTS provider_permits_active_idx
  ON provider_permits(provider, operation, expires_at)
  WHERE released_at IS NULL;
