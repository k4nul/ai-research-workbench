-- Forward-fix migration for databases upgraded while another schema contained
-- identically named constraints. PostgreSQL constraint names are schema-local,
-- so every existence check must be scoped to the intended relation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'research_projects_scope_revision_fkey'
      AND conrelid = 'research_projects'::regclass
  ) THEN
    ALTER TABLE research_projects
      ADD CONSTRAINT research_projects_scope_revision_fkey
      FOREIGN KEY (id, scope_approved_revision_id)
      REFERENCES approval_revisions(project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'research_projects_plan_revision_fkey'
      AND conrelid = 'research_projects'::regclass
  ) THEN
    ALTER TABLE research_projects
      ADD CONSTRAINT research_projects_plan_revision_fkey
      FOREIGN KEY (id, plan_approved_revision_id)
      REFERENCES approval_revisions(project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_run_fkey' AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_run_fkey
      FOREIGN KEY (project_id, run_id) REFERENCES research_runs(project_id, id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_run_stage_fkey' AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_run_stage_fkey
      FOREIGN KEY (run_id, run_stage_id) REFERENCES research_run_stages(run_id, id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_parent_fkey' AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_parent_fkey
      FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_research_run_fkey' AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_research_run_fkey
      FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_run_stage_fkey' AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_run_stage_fkey
      FOREIGN KEY (run_stage_id) REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_job_fkey' AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_job_fkey
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_job_attempt_fkey' AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs
      ADD CONSTRAINT ai_runs_job_attempt_fkey
      FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_generated_run_stage_fkey'
      AND conrelid = 'evidence'::regclass
  ) THEN
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'claims_generated_run_stage_fkey'
      AND conrelid = 'claims'::regclass
  ) THEN
    ALTER TABLE claims
      ADD CONSTRAINT claims_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'findings_generated_run_stage_fkey'
      AND conrelid = 'findings'::regclass
  ) THEN
    ALTER TABLE findings
      ADD CONSTRAINT findings_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'qa_findings_generated_run_stage_fkey'
      AND conrelid = 'qa_findings'::regclass
  ) THEN
    ALTER TABLE qa_findings
      ADD CONSTRAINT qa_findings_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'research_questions_gap_run_stage_fkey'
      AND conrelid = 'research_questions'::regclass
  ) THEN
    ALTER TABLE research_questions
      ADD CONSTRAINT research_questions_gap_run_stage_fkey
      FOREIGN KEY (gap_generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
END
$$;
