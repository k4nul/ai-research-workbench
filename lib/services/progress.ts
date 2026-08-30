import type { PoolClient } from "pg";

type ProgressEvidence = {
  scope_ready: boolean;
  plan_ready: boolean;
  questions_ready: boolean;
  claims_ready: boolean;
  report_ready: boolean;
  qa_ready: boolean;
  approval_ready: boolean;
  export_ready: boolean;
};

export async function refreshProjectProgress(
  client: PoolClient,
  projectId: string
): Promise<number> {
  const result = await client.query<ProgressEvidence>(
    "SELECT " +
      "(p.scope_approved_at IS NOT NULL) AS scope_ready, " +
      "(p.plan_approved_at IS NOT NULL AND EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id AND NOT EXISTS (SELECT 1 FROM research_plans rp WHERE rp.question_id = rq.id AND rp.project_id = p.id AND rp.human_approved = TRUE))) AS plan_ready, " +
      "(EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id AND rq.status <> 'COMPLETE' AND rq.gap_status NOT IN ('ACCEPTED', 'RESOLVED'))) AS questions_ready, " +
      "(EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE AND (c.verification_possible = FALSE OR NOT EXISTS (SELECT 1 FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id WHERE ce.claim_id = c.id AND ce.relationship = 'SUPPORTS' AND e.verification_status = 'VERIFIED')))) AS claims_ready, " +
      "COALESCE((SELECT REGEXP_REPLACE(COALESCE(d.sections->>'researchPurpose', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'executiveSummary', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'researchScope', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'methodology', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'keyFindings', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'detailedAnalysis', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'risksAndLimitations', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'recommendations', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'references', ''), '[[:space:]]', '', 'g') <> '' FROM deliverables d WHERE d.project_id = p.id ORDER BY d.version DESC LIMIT 1), FALSE) AS report_ready, " +
      "(p.qa_passed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qa_findings q WHERE q.project_id = p.id AND q.severity = 'BLOCKER' AND q.resolution_status <> 'RESOLVED')) AS qa_ready, " +
      "(p.approval_status = 'APPROVED') AS approval_ready, " +
      "(EXISTS (SELECT 1 FROM project_exports x WHERE x.project_id = p.id AND x.format = 'ZIP' AND x.is_current = TRUE)) AS export_ready " +
      "FROM research_projects p WHERE p.id = $1",
    [projectId]
  );
  const evidence = result.rows[0];
  if (!evidence) {
    return 0;
  }
  const complete = Object.values(evidence).filter(Boolean).length;
  const progress = Math.round((complete / 8) * 100);
  await client.query(
    "UPDATE research_projects SET progress = $2, updated_at = NOW() WHERE id = $1",
    [projectId, progress]
  );
  return progress;
}
