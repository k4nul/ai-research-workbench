CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  service_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTING', 'READY', 'DRAINING', 'STOPPED', 'FAILED')),
  concurrency INTEGER NOT NULL CHECK (concurrency > 0),
  active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
  provider_concurrency INTEGER NOT NULL CHECK (provider_concurrency > 0),
  extraction_concurrency INTEGER NOT NULL CHECK (extraction_concurrency > 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  run_stage_id TEXT REFERENCES research_run_stages(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  job_attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  operation TEXT NOT NULL,
  request_id TEXT,
  client_request_id TEXT,
  provider_response_id TEXT,
  prompt_template_version TEXT,
  structured_schema_version TEXT,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  input_tokens BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens BIGINT CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cost_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (cost_status IN ('KNOWN', 'ESTIMATED', 'UNKNOWN')),
  estimated_cost NUMERIC(18, 8),
  error_class TEXT,
  sanitized_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  CHECK (cost_status <> 'UNKNOWN' OR estimated_cost IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_executions_response_idx
  ON provider_executions(provider, provider_response_id)
  WHERE provider_response_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_executions_run_idx
  ON provider_executions(run_id, run_stage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS provider_executions_provider_status_idx
  ON provider_executions(provider, status, started_at DESC);

CREATE TABLE IF NOT EXISTS provider_rate_windows (
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  request_limit INTEGER NOT NULL CHECK (request_limit > 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit > 0),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, operation)
);

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

CREATE TABLE IF NOT EXISTS provider_canary_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'NOT_RUN_NO_CREDENTIALS')),
  request_id TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  usage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  sanitized_error TEXT,
  synthetic_input BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('MOCK', 'LIVE')),
  status TEXT NOT NULL CHECK (status IN (
    'RUNNING', 'PASSED', 'FAILED', 'NOT_RUN_NO_CREDENTIALS'
  )),
  pipeline_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT NOT NULL,
  fixture_count INTEGER NOT NULL DEFAULT 0 CHECK (fixture_count >= 0),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  artifact_reference JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(artifact_reference) = 'object'),
  estimated_cost NUMERIC(18, 8),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (estimated_cost IS NULL OR estimated_cost >= 0)
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_status_idx
  ON worker_heartbeats(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS provider_canary_runs_provider_idx
  ON provider_canary_runs(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_permits_active_idx
  ON provider_permits(provider, operation, expires_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS evaluation_runs_created_idx
  ON evaluation_runs(created_at DESC);
