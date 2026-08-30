CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_research_language TEXT NOT NULL DEFAULT 'en',
  default_report_language TEXT NOT NULL DEFAULT 'en',
  default_citation_style TEXT NOT NULL DEFAULT 'APA',
  default_quality_standard JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL,
  contact_name TEXT,
  contact_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  internal_notes TEXT,
  security_classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (security_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  core_question TEXT NOT NULL,
  background TEXT,
  purpose TEXT NOT NULL,
  audience TEXT NOT NULL,
  scope TEXT NOT NULL,
  exclusions TEXT,
  jurisdiction TEXT,
  research_date DATE NOT NULL,
  source_max_age_days INTEGER NOT NULL DEFAULT 365 CHECK (source_max_age_days >= 0),
  deadline DATE,
  deliverable_formats TEXT[] NOT NULL DEFAULT ARRAY['MARKDOWN', 'HTML', 'PDF', 'DOCX'],
  special_requirements TEXT,
  status TEXT NOT NULL DEFAULT 'INTAKE'
    CHECK (status IN (
      'INTAKE', 'SCOPING', 'PLANNING', 'RESEARCHING', 'SYNTHESIZING',
      'QA', 'APPROVAL_REQUIRED', 'APPROVED', 'DELIVERED', 'ARCHIVED'
    )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  approval_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (approval_status IN ('NOT_REQUESTED', 'PENDING', 'APPROVED', 'REJECTED')),
  scope_approved_at TIMESTAMPTZ,
  plan_approved_at TIMESTAMPTZ,
  qa_passed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES research_questions(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'PLANNED', 'RESEARCHING', 'COMPLETE', 'BLOCKED')),
  completion_criteria TEXT NOT NULL,
  research_gap TEXT,
  gap_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (gap_status IN ('NONE', 'OPEN', 'ACCEPTED', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
  search_strategy TEXT NOT NULL,
  search_queries TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  primary_source_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  secondary_source_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  comparison_targets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expected_output TEXT NOT NULL,
  assigned_stage TEXT NOT NULL DEFAULT 'RESEARCHING',
  completion_condition TEXT NOT NULL,
  expected_risks TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  research_gap TEXT,
  ai_suggested BOOLEAN NOT NULL DEFAULT FALSE,
  human_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  reused_from_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  url TEXT,
  title TEXT NOT NULL,
  publisher TEXT,
  author TEXT,
  published_at DATE,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  original_status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (original_status IN ('AVAILABLE', 'ARCHIVED', 'PAYWALLED', 'REMOVED', 'UPLOAD')),
  reliability_grade TEXT NOT NULL DEFAULT 'B'
    CHECK (reliability_grade IN ('A', 'B', 'C', 'D', 'UNRATED')),
  freshness_status TEXT NOT NULL DEFAULT 'CURRENT'
    CHECK (freshness_status IN ('CURRENT', 'AGING', 'OUTDATED', 'UNKNOWN')),
  duplicate_of_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  content_hash TEXT,
  usage_restrictions TEXT,
  ingestion_method TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (ingestion_method IN ('MANUAL', 'FETCH', 'UPLOAD', 'SEARCH', 'IMPORT', 'REUSE')),
  mime_type TEXT,
  content_summary TEXT,
  sanitized_content TEXT,
  prompt_injection_flag BOOLEAN NOT NULL DEFAULT FALSE,
  fetch_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  minimal_quote TEXT,
  original_location TEXT,
  page_or_section TEXT,
  confidence TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  verification_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES research_questions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('FACT', 'INTERPRETATION', 'INFERENCE', 'RECOMMENDATION')),
  importance TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (importance IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  support_status TEXT NOT NULL DEFAULT 'UNSUPPORTED'
    CHECK (support_status IN (
      'SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONTESTED', 'UNSUPPORTED',
      'OUTDATED', 'NOT_VERIFIABLE'
    )),
  fact_or_inference TEXT NOT NULL DEFAULT 'FACT'
    CHECK (fact_or_inference IN ('FACT', 'INFERENCE')),
  include_in_report BOOLEAN NOT NULL DEFAULT TRUE,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('SUPPORTS', 'REFUTES', 'CONTEXT')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claim_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES research_questions(id) ON DELETE SET NULL,
  finding TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (importance IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  impact TEXT,
  limitations TEXT,
  can_inform_recommendation BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finding_claims (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  PRIMARY KEY (finding_id, claim_id)
);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ,
  approval_status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (approval_status IN ('DRAFT', 'REVIEW', 'APPROVED', 'SUPERSEDED')),
  export_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS deliverable_revisions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'AI', 'SYSTEM')),
  changed_sections TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  previous_sections JSONB NOT NULL,
  new_sections JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qa_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  deliverable_id TEXT REFERENCES deliverables(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('BLOCKER', 'HIGH', 'MEDIUM', 'LOW')),
  location TEXT NOT NULL,
  problem TEXT NOT NULL,
  remediation TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (resolution_status IN ('OPEN', 'RESOLVED', 'ACCEPTED_RISK')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'AI', 'SYSTEM')),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  duration_ms INTEGER,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED')),
  input_reference JSONB NOT NULL,
  output_reference JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('MARKDOWN', 'HTML', 'PDF', 'DOCX', 'CSV', 'ZIP')),
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clients_workspace_idx ON clients(workspace_id);
CREATE INDEX IF NOT EXISTS projects_workspace_status_idx ON research_projects(workspace_id, status);
CREATE INDEX IF NOT EXISTS projects_deadline_idx ON research_projects(deadline);
CREATE INDEX IF NOT EXISTS questions_project_idx ON research_questions(project_id);
CREATE INDEX IF NOT EXISTS sources_project_idx ON sources(project_id);
CREATE INDEX IF NOT EXISTS sources_hash_idx ON sources(project_id, content_hash);
CREATE INDEX IF NOT EXISTS evidence_source_idx ON evidence(source_id);
CREATE INDEX IF NOT EXISTS claims_project_support_idx ON claims(project_id, support_status);
CREATE INDEX IF NOT EXISTS qa_project_status_idx ON qa_findings(project_id, resolution_status, severity);
CREATE INDEX IF NOT EXISTS audit_project_created_idx ON audit_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_schedule_idx ON jobs(status, scheduled_at);
