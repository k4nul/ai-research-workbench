WITH committed_stages AS (
  SELECT
    rrs.id,
    rrs.run_id,
    rrs.stage_id,
    rrs.generation,
    rrs.status,
    ROW_NUMBER() OVER (
      PARTITION BY rr.project_id, rrs.stage_id
      ORDER BY sdc.committed_at DESC, rrs.created_at DESC, rrs.id DESC
    ) AS commit_rank
  FROM research_run_stages rrs
  JOIN research_runs rr ON rr.id = rrs.run_id
  JOIN stage_domain_commits sdc ON sdc.run_stage_id = rrs.id
), current_stages AS (
  SELECT id
  FROM committed_stages
  WHERE commit_rank = 1
    AND status = 'SUCCEEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM research_run_stages newer
      WHERE newer.run_id = committed_stages.run_id
        AND newer.stage_id = committed_stages.stage_id
        AND newer.generation > committed_stages.generation
    )
)
UPDATE evidence e
SET is_current = FALSE, updated_at = NOW()
WHERE e.generated_by_run_stage_id IS NOT NULL
  AND e.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM current_stages current_stage
    WHERE current_stage.id = e.generated_by_run_stage_id
  );

WITH committed_stages AS (
  SELECT
    rrs.id,
    rrs.run_id,
    rrs.stage_id,
    rrs.generation,
    rrs.status,
    ROW_NUMBER() OVER (
      PARTITION BY rr.project_id, rrs.stage_id
      ORDER BY sdc.committed_at DESC, rrs.created_at DESC, rrs.id DESC
    ) AS commit_rank
  FROM research_run_stages rrs
  JOIN research_runs rr ON rr.id = rrs.run_id
  JOIN stage_domain_commits sdc ON sdc.run_stage_id = rrs.id
), current_stages AS (
  SELECT id
  FROM committed_stages
  WHERE commit_rank = 1
    AND status = 'SUCCEEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM research_run_stages newer
      WHERE newer.run_id = committed_stages.run_id
        AND newer.stage_id = committed_stages.stage_id
        AND newer.generation > committed_stages.generation
    )
)
UPDATE claims c
SET is_current = FALSE, updated_at = NOW()
WHERE c.generated_by_run_stage_id IS NOT NULL
  AND c.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM current_stages current_stage
    WHERE current_stage.id = c.generated_by_run_stage_id
  );

WITH committed_stages AS (
  SELECT
    rrs.id,
    rrs.run_id,
    rrs.stage_id,
    rrs.generation,
    rrs.status,
    ROW_NUMBER() OVER (
      PARTITION BY rr.project_id, rrs.stage_id
      ORDER BY sdc.committed_at DESC, rrs.created_at DESC, rrs.id DESC
    ) AS commit_rank
  FROM research_run_stages rrs
  JOIN research_runs rr ON rr.id = rrs.run_id
  JOIN stage_domain_commits sdc ON sdc.run_stage_id = rrs.id
), current_stages AS (
  SELECT id
  FROM committed_stages
  WHERE commit_rank = 1
    AND status = 'SUCCEEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM research_run_stages newer
      WHERE newer.run_id = committed_stages.run_id
        AND newer.stage_id = committed_stages.stage_id
        AND newer.generation > committed_stages.generation
    )
)
UPDATE findings f
SET is_current = FALSE, updated_at = NOW()
WHERE f.generated_by_run_stage_id IS NOT NULL
  AND f.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM current_stages current_stage
    WHERE current_stage.id = f.generated_by_run_stage_id
  );

WITH committed_stages AS (
  SELECT
    rrs.id,
    rrs.run_id,
    rrs.stage_id,
    rrs.generation,
    rrs.status,
    ROW_NUMBER() OVER (
      PARTITION BY rr.project_id, rrs.stage_id
      ORDER BY sdc.committed_at DESC, rrs.created_at DESC, rrs.id DESC
    ) AS commit_rank
  FROM research_run_stages rrs
  JOIN research_runs rr ON rr.id = rrs.run_id
  JOIN stage_domain_commits sdc ON sdc.run_stage_id = rrs.id
), current_stages AS (
  SELECT id
  FROM committed_stages
  WHERE commit_rank = 1
    AND status = 'SUCCEEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM research_run_stages newer
      WHERE newer.run_id = committed_stages.run_id
        AND newer.stage_id = committed_stages.stage_id
        AND newer.generation > committed_stages.generation
    )
)
UPDATE qa_findings qf
SET is_current = FALSE, updated_at = NOW()
WHERE qf.generated_by_run_stage_id IS NOT NULL
  AND qf.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM current_stages current_stage
    WHERE current_stage.id = qf.generated_by_run_stage_id
  );

WITH committed_stages AS (
  SELECT
    rrs.id,
    rrs.run_id,
    rrs.stage_id,
    rrs.generation,
    rrs.status,
    ROW_NUMBER() OVER (
      PARTITION BY rr.project_id, rrs.stage_id
      ORDER BY sdc.committed_at DESC, rrs.created_at DESC, rrs.id DESC
    ) AS commit_rank
  FROM research_run_stages rrs
  JOIN research_runs rr ON rr.id = rrs.run_id
  JOIN stage_domain_commits sdc ON sdc.run_stage_id = rrs.id
), current_stages AS (
  SELECT id
  FROM committed_stages
  WHERE commit_rank = 1
    AND status = 'SUCCEEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM research_run_stages newer
      WHERE newer.run_id = committed_stages.run_id
        AND newer.stage_id = committed_stages.stage_id
        AND newer.generation > committed_stages.generation
    )
)
UPDATE research_questions rq
SET research_gap = NULL,
    gap_status = 'NONE',
    gap_generated_by_run_stage_id = NULL,
    updated_at = NOW()
WHERE rq.gap_generated_by_run_stage_id IS NOT NULL
  AND rq.gap_status = 'OPEN'
  AND NOT EXISTS (
    SELECT 1 FROM current_stages current_stage
    WHERE current_stage.id = rq.gap_generated_by_run_stage_id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM evidence
    WHERE id LIKE 'ai-evidence-%' AND generated_by_run_stage_id IS NULL
  ) THEN
    RAISE EXCEPTION 'AI evidence remains without run-stage provenance';
  END IF;

  IF EXISTS (
    SELECT 1 FROM claims
    WHERE id LIKE 'ai-claim-%' AND generated_by_run_stage_id IS NULL
  ) THEN
    RAISE EXCEPTION 'AI claims remain without run-stage provenance';
  END IF;

  IF EXISTS (
    SELECT 1 FROM qa_findings
    WHERE (id LIKE 'ai-qa-%' OR id LIKE 'ai-conflict-%')
      AND generated_by_run_stage_id IS NULL
  ) THEN
    RAISE EXCEPTION 'AI QA findings remain without run-stage provenance';
  END IF;
END
$$;
