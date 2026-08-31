ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS generated_by_run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS generated_by_run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS generated_by_run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE qa_findings
  ADD COLUMN IF NOT EXISTS generated_by_run_stage_id TEXT,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE research_questions
  ADD COLUMN IF NOT EXISTS gap_generated_by_run_stage_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_generated_run_stage_fkey'
  ) THEN
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'claims_generated_run_stage_fkey'
  ) THEN
    ALTER TABLE claims
      ADD CONSTRAINT claims_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'findings_generated_run_stage_fkey'
  ) THEN
    ALTER TABLE findings
      ADD CONSTRAINT findings_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'qa_findings_generated_run_stage_fkey'
  ) THEN
    ALTER TABLE qa_findings
      ADD CONSTRAINT qa_findings_generated_run_stage_fkey
      FOREIGN KEY (generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'research_questions_gap_run_stage_fkey'
  ) THEN
    ALTER TABLE research_questions
      ADD CONSTRAINT research_questions_gap_run_stage_fkey
      FOREIGN KEY (gap_generated_by_run_stage_id)
      REFERENCES research_run_stages(id) ON DELETE SET NULL;
  END IF;
END
$$;

UPDATE evidence e
SET generated_by_run_stage_id = rrs.id
FROM research_run_stages rrs
WHERE e.generated_by_run_stage_id IS NULL
  AND e.id LIKE 'ai-evidence-' || rrs.id || '-%';

UPDATE claims c
SET generated_by_run_stage_id = rrs.id
FROM research_run_stages rrs
WHERE c.generated_by_run_stage_id IS NULL
  AND c.id LIKE 'ai-claim-' || rrs.id || '-%';

UPDATE qa_findings qf
SET generated_by_run_stage_id = rrs.id
FROM research_run_stages rrs
WHERE qf.generated_by_run_stage_id IS NULL
  AND qf.id LIKE 'ai-qa-' || rrs.id || '-%';

CREATE INDEX IF NOT EXISTS evidence_current_generated_stage_idx
  ON evidence(generated_by_run_stage_id)
  WHERE is_current = TRUE AND generated_by_run_stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS claims_current_generated_stage_idx
  ON claims(generated_by_run_stage_id)
  WHERE is_current = TRUE AND generated_by_run_stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS findings_current_generated_stage_idx
  ON findings(generated_by_run_stage_id)
  WHERE is_current = TRUE AND generated_by_run_stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS qa_findings_current_generated_stage_idx
  ON qa_findings(generated_by_run_stage_id)
  WHERE is_current = TRUE AND generated_by_run_stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS research_questions_gap_generated_stage_idx
  ON research_questions(gap_generated_by_run_stage_id)
  WHERE gap_generated_by_run_stage_id IS NOT NULL;
