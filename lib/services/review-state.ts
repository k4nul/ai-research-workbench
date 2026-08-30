import type { PoolClient } from "pg";

export async function invalidateDownstreamReview(
  client: PoolClient,
  projectId: string,
  fallbackStatus: "RESEARCHING" | "SYNTHESIZING" | "QA"
): Promise<void> {
  await client.query(
    "UPDATE research_projects SET qa_passed_at = NULL, approval_status = 'NOT_REQUESTED', approved_at = NULL, delivered_at = NULL, status = CASE WHEN status IN ('QA', 'APPROVAL_REQUIRED', 'APPROVED', 'DELIVERED') THEN $2 ELSE status END, updated_at = NOW() WHERE id = $1",
    [projectId, fallbackStatus]
  );
  await client.query(
    "UPDATE deliverables SET approval_status = CASE WHEN approval_status = 'APPROVED' THEN 'REVIEW' ELSE approval_status END, updated_at = NOW() WHERE project_id = $1",
    [projectId]
  );
}
