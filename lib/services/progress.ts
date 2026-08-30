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
      "(p.plan_approved_at IS NOT NULL AND EXISTS (SELECT 1 FROM research_plans rp WHERE rp.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_plans rp WHERE rp.project_id = p.id AND rp.human_approved = FALSE)) AS plan_ready, " +
      "(EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id AND rq.status <> 'COMPLETE' AND rq.gap_status NOT IN ('ACCEPTED', 'RESOLVED'))) AS questions_ready, " +
      "(EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE AND c.support_status IN ('UNSUPPORTED', 'NOT_VERIFIABLE'))) AS claims_ready, " +
      "(EXISTS (SELECT 1 FROM deliverables d WHERE d.project_id = p.id AND COALESCE(d.sections->>'executiveSummary', '') <> '' AND COALESCE(d.sections->>'methodology', '') <> '' AND COALESCE(d.sections->>'keyFindings', '') <> '' AND COALESCE(d.sections->>'risksAndLimitations', '') <> '')) AS report_ready, " +
      "(p.qa_passed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qa_findings q WHERE q.project_id = p.id AND q.severity = 'BLOCKER' AND q.resolution_status <> 'RESOLVED')) AS qa_ready, " +
      "(p.approval_status = 'APPROVED') AS approval_ready, " +
      "(EXISTS (SELECT 1 FROM project_exports x WHERE x.project_id = p.id AND x.format = 'ZIP')) AS export_ready " +
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
