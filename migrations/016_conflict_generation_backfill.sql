UPDATE qa_findings qf
SET generated_by_run_stage_id = rrs.id
FROM research_run_stages rrs
WHERE qf.generated_by_run_stage_id IS NULL
  AND qf.id LIKE 'ai-conflict-' || rrs.id || '-%';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM qa_findings qf
    JOIN research_run_stages rrs
      ON qf.id LIKE 'ai-conflict-' || rrs.id || '-%'
    WHERE qf.generated_by_run_stage_id IS NULL
  ) THEN
    RAISE EXCEPTION 'AI conflict findings remain without run-stage provenance';
  END IF;
END
$$;
