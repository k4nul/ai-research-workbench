CREATE TABLE IF NOT EXISTS approval_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SCOPE', 'PLAN')),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  content_hash TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, kind, revision_number),
  UNIQUE (project_id, kind, content_hash),
  UNIQUE (project_id, id)
);

ALTER TABLE research_projects
  ADD COLUMN IF NOT EXISTS scope_approved_revision_id TEXT,
  ADD COLUMN IF NOT EXISTS plan_approved_revision_id TEXT;

WITH scope_snapshots AS (
  SELECT
    p.id AS project_id,
    jsonb_build_object(
      'coreQuestion', p.core_question,
      'background', p.background,
      'purpose', p.purpose,
      'audience', p.audience,
      'scope', p.scope,
      'exclusions', p.exclusions,
      'jurisdiction', p.jurisdiction,
      'researchDate', p.research_date,
      'sourceMaxAgeDays', p.source_max_age_days,
      'deadline', p.deadline,
      'deliverableFormats', p.deliverable_formats,
      'specialRequirements', p.special_requirements
    ) AS snapshot,
    p.scope_approved_at AS approved_at
  FROM research_projects p
  WHERE p.scope_approved_at IS NOT NULL
)
INSERT INTO approval_revisions (
  id,
  project_id,
  kind,
  revision_number,
  snapshot,
  content_hash,
  approved_at,
  created_by
)
SELECT
  'legacy-scope-' || md5(project_id),
  project_id,
  'SCOPE',
  1,
  snapshot,
  'legacy-md5:' || md5(snapshot::text),
  approved_at,
  'v0.2 migration'
FROM scope_snapshots
ON CONFLICT DO NOTHING;

WITH plan_snapshots AS (
  SELECT
    p.id AS project_id,
    jsonb_build_object(
      'questions', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', rq.id,
            'parentId', rq.parent_id,
            'question', rq.question,
            'priority', rq.priority,
            'completionCriteria', rq.completion_criteria,
            'plan', CASE
              WHEN rp.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', rp.id,
                'searchStrategy', rp.search_strategy,
                'searchQueries', rp.search_queries,
                'primarySourceTypes', rp.primary_source_types,
                'secondarySourceTypes', rp.secondary_source_types,
                'comparisonTargets', rp.comparison_targets,
                'expectedOutput', rp.expected_output,
                'assignedStage', rp.assigned_stage,
                'completionCondition', rp.completion_condition,
                'expectedRisks', rp.expected_risks,
                'researchGap', rp.research_gap,
                'humanApproved', rp.human_approved,
                'approvedAt', rp.approved_at
              )
            END
          ) ORDER BY rq.created_at, rq.id
        ) FILTER (WHERE rq.id IS NOT NULL),
        '[]'::jsonb
      )
    ) AS snapshot,
    p.plan_approved_at AS approved_at
  FROM research_projects p
  LEFT JOIN research_questions rq ON rq.project_id = p.id
  LEFT JOIN research_plans rp ON rp.question_id = rq.id AND rp.project_id = p.id
  WHERE p.plan_approved_at IS NOT NULL
  GROUP BY p.id, p.plan_approved_at
)
INSERT INTO approval_revisions (
  id,
  project_id,
  kind,
  revision_number,
  snapshot,
  content_hash,
  approved_at,
  created_by
)
SELECT
  'legacy-plan-' || md5(project_id),
  project_id,
  'PLAN',
  1,
  snapshot,
  'legacy-md5:' || md5(snapshot::text),
  approved_at,
  'v0.2 migration'
FROM plan_snapshots
ON CONFLICT DO NOTHING;

UPDATE research_projects
SET scope_approved_revision_id = 'legacy-scope-' || md5(id)
WHERE scope_approved_at IS NOT NULL
  AND scope_approved_revision_id IS NULL;

UPDATE research_projects
SET plan_approved_revision_id = 'legacy-plan-' || md5(id)
WHERE plan_approved_at IS NOT NULL
  AND plan_approved_revision_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'research_projects_scope_revision_fkey'
  ) THEN
    ALTER TABLE research_projects
      ADD CONSTRAINT research_projects_scope_revision_fkey
      FOREIGN KEY (id, scope_approved_revision_id)
      REFERENCES approval_revisions(project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'research_projects_plan_revision_fkey'
  ) THEN
    ALTER TABLE research_projects
      ADD CONSTRAINT research_projects_plan_revision_fkey
      FOREIGN KEY (id, plan_approved_revision_id)
      REFERENCES approval_revisions(project_id, id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ASSISTED', 'ORCHESTRATED', 'DRAFT_ONLY')),
  status TEXT NOT NULL CHECK (status IN (
    'CREATED', 'WAITING_FOR_PLAN_APPROVAL', 'QUEUED', 'RUNNING', 'PAUSED',
    'CANCELLING', 'CANCELLED', 'FAILED', 'QA_REQUIRED',
    'APPROVAL_REQUIRED', 'COMPLETED', 'BLOCKED'
  )),
  scope_revision_id TEXT,
  plan_revision_id TEXT,
  scope_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(plan_snapshot) = 'object'),
  pipeline_version TEXT NOT NULL,
  provider_config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provider_config_snapshot) = 'object'),
  model_config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(model_config_snapshot) = 'object'),
  search_config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(search_config_snapshot) = 'object'),
  budget_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(budget_snapshot) = 'object'),
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN (
    'intake_analysis', 'question_decomposition', 'research_plan', 'source_summary',
    'evidence_extraction', 'claim_generation', 'gap_detection',
    'conflict_detection', 'report_outline', 'draft_generation', 'qa_revision'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
  total_provider_requests INTEGER NOT NULL DEFAULT 0 CHECK (total_provider_requests >= 0),
  total_search_requests INTEGER NOT NULL DEFAULT 0 CHECK (total_search_requests >= 0),
  total_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0),
  total_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_output_tokens >= 0),
  estimated_cost NUMERIC(18, 8),
  cost_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (cost_status IN ('KNOWN', 'ESTIMATED', 'UNKNOWN')),
  failure_reason TEXT,
  block_reason TEXT,
  created_by TEXT NOT NULL,
  cancelled_by TEXT,
  resume_source_run_id TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (project_id, idempotency_key),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, scope_revision_id)
    REFERENCES approval_revisions(project_id, id),
  FOREIGN KEY (project_id, plan_revision_id)
    REFERENCES approval_revisions(project_id, id),
  CHECK (
    status IN ('CREATED', 'WAITING_FOR_PLAN_APPROVAL')
    OR (scope_revision_id IS NOT NULL AND plan_revision_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS research_run_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL CHECK (stage_id IN (
    'intake_analysis', 'question_decomposition', 'research_plan', 'source_summary',
    'evidence_extraction', 'claim_generation', 'gap_detection',
    'conflict_detection', 'report_outline', 'draft_generation', 'qa_revision'
  )),
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 11),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED',
    'CANCELLED', 'BLOCKED', 'STALE'
  )),
  pipeline_version TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  structured_schema_version TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_reference JSONB,
  input_hash TEXT,
  output_reference JSONB,
  output_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  usage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  cost_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (cost_status IN ('KNOWN', 'ESTIMATED', 'UNKNOWN')),
  estimated_cost NUMERIC(18, 8),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_class TEXT,
  sanitized_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stale_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (run_id, stage_id, generation),
  UNIQUE (run_id, id)
);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS run_id TEXT,
  ADD COLUMN IF NOT EXISTS run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS input_reference JSONB,
  ADD COLUMN IF NOT EXISTS input_hash TEXT,
  ADD COLUMN IF NOT EXISTS output_reference JSONB,
  ADD COLUMN IF NOT EXISTS output_hash TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timeout_ms INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS retry_policy JSONB NOT NULL DEFAULT
    '{"baseDelayMs":1000,"maxDelayMs":60000,"jitterRatio":0.2}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_class TEXT,
  ADD COLUMN IF NOT EXISTS sanitized_error TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_job_id TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'QUEUED';

UPDATE jobs
SET
  status = CASE status
    WHEN 'PENDING' THEN 'QUEUED'
    WHEN 'RUNNING' THEN 'RETRY_WAIT'
    ELSE status
  END,
  scheduled_at = CASE WHEN status = 'RUNNING' THEN NOW() ELSE scheduled_at END
WHERE idempotency_key IS NULL
  AND status IN ('PENDING', 'RUNNING');

UPDATE jobs
SET
  idempotency_key = 'legacy:' || id,
  input_reference = payload,
  input_hash = 'legacy-md5:' || md5(payload::text),
  correlation_id = COALESCE(correlation_id, id),
  updated_at = COALESCE(updated_at, created_at)
WHERE idempotency_key IS NULL;

UPDATE jobs
SET
  attempts = GREATEST(attempts, 0),
  max_attempts = GREATEST(max_attempts, attempts, 1);

ALTER TABLE jobs
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN input_reference SET NOT NULL,
  ALTER COLUMN input_hash SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAIT',
    'CANCELLATION_REQUESTED', 'CANCELLED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'
  ));

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_attempts_check CHECK (
    attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts
  );

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_timeout_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_timeout_check CHECK (timeout_ms > 0);

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_retry_policy_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_retry_policy_check CHECK (jsonb_typeof(retry_policy) = 'object');

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_error_class_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_error_class_check CHECK (
    error_class IS NULL OR error_class IN (
      'RETRYABLE_PROVIDER_RATE_LIMIT', 'RETRYABLE_PROVIDER_SERVER_ERROR',
      'RETRYABLE_NETWORK', 'RETRYABLE_STORAGE', 'RETRYABLE_TIMEOUT',
      'NON_RETRYABLE_VALIDATION', 'NON_RETRYABLE_SECURITY',
      'NON_RETRYABLE_BUDGET', 'NON_RETRYABLE_USER_INPUT',
      'CANCELLED', 'UNKNOWN'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_run_fkey'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_run_fkey
      FOREIGN KEY (project_id, run_id) REFERENCES research_runs(project_id, id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_run_stage_fkey'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_run_stage_fkey
      FOREIGN KEY (run_id, run_stage_id) REFERENCES research_run_stages(run_id, id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_parent_fkey'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_parent_fkey
      FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRY_WAIT',
    'CANCELLED', 'DEAD_LETTER', 'LEASE_EXPIRED'
  )),
  error_class TEXT,
  sanitized_error TEXT,
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  worker_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stage_domain_commits (
  id TEXT PRIMARY KEY,
  run_stage_id TEXT NOT NULL REFERENCES research_run_stages(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  idempotency_key TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_stage_id, generation, idempotency_key)
);

ALTER TABLE ai_runs
  ADD COLUMN IF NOT EXISTS research_run_id TEXT,
  ADD COLUMN IF NOT EXISTS run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS job_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER,
  ADD COLUMN IF NOT EXISTS structured_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS output_hash TEXT,
  ADD COLUMN IF NOT EXISTS provider_response_id TEXT,
  ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(18, 8);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_runs_research_run_fkey'
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_research_run_fkey
      FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_runs_run_stage_fkey'
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_run_stage_fkey
      FOREIGN KEY (run_stage_id) REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_runs_job_fkey'
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_job_fkey
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_runs_job_attempt_fkey'
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_job_attempt_fkey
      FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx
  ON jobs(COALESCE(project_id, ''), idempotency_key);

CREATE INDEX IF NOT EXISTS jobs_ready_idx
  ON jobs(priority DESC, scheduled_at, id)
  WHERE status IN ('QUEUED', 'RETRY_WAIT');

CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
  ON jobs(lease_expires_at, id)
  WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED');

CREATE INDEX IF NOT EXISTS jobs_run_stage_idx ON jobs(run_id, run_stage_id, created_at);
CREATE INDEX IF NOT EXISTS job_events_job_created_idx ON job_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS research_runs_project_created_idx
  ON research_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_run_stages_run_ordinal_idx
  ON research_run_stages(run_id, ordinal, generation DESC);
