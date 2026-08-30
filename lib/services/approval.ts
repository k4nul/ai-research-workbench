import { withTransaction } from "@/lib/db";
import { conflict, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";
import { refreshProjectProgress } from "@/lib/services/progress";

type ApprovalAction = "request" | "approve" | "deliver";

type WorkflowReadiness = {
  scope_ready: boolean;
  plan_ready: boolean;
  questions_ready: boolean;
  claims_ready: boolean;
  findings_ready: boolean;
  report_ready: boolean;
};

export async function runApprovalAction(
  projectId: string,
  action: ApprovalAction,
  confirmation = false
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    const project = await client.query<{
      status: string;
      approval_status: string;
      qa_passed_at: string | null;
    }>(
      "SELECT status, approval_status, qa_passed_at FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    const blockers = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM qa_findings WHERE project_id = $1 AND severity = 'BLOCKER' AND resolution_status <> 'RESOLVED'",
      [projectId]
    );
    if (Number(blockers.rows[0].count) > 0 || !project.rows[0].qa_passed_at) {
      throw conflict("QA_BLOCKED", "The project must pass QA with no open blockers.");
    }
    const readiness = await client.query<WorkflowReadiness>(
      "SELECT " +
        "(p.scope_approved_at IS NOT NULL) AS scope_ready, " +
        "(p.plan_approved_at IS NOT NULL AND EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id AND NOT EXISTS (SELECT 1 FROM research_plans rp WHERE rp.question_id = rq.id AND rp.project_id = p.id AND rp.human_approved = TRUE))) AS plan_ready, " +
        "(EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM research_questions rq WHERE rq.project_id = p.id AND rq.status <> 'COMPLETE' AND rq.gap_status NOT IN ('ACCEPTED', 'RESOLVED'))) AS questions_ready, " +
        "(EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.project_id = p.id AND c.include_in_report = TRUE AND (c.verification_possible = FALSE OR NOT EXISTS (SELECT 1 FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id WHERE ce.claim_id = c.id AND ce.relationship = 'SUPPORTS' AND e.verification_status = 'VERIFIED')))) AS claims_ready, " +
        "(EXISTS (SELECT 1 FROM findings f WHERE f.project_id = p.id) AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.project_id = p.id AND NOT EXISTS (SELECT 1 FROM finding_claims fc JOIN claims c ON c.id = fc.claim_id WHERE fc.finding_id = f.id AND c.include_in_report = TRUE AND c.verification_possible = TRUE AND EXISTS (SELECT 1 FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id WHERE ce.claim_id = c.id AND ce.relationship = 'SUPPORTS' AND e.verification_status = 'VERIFIED')))) AS findings_ready, " +
        "COALESCE((SELECT REGEXP_REPLACE(COALESCE(d.sections->>'researchPurpose', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'executiveSummary', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'researchScope', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'methodology', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'keyFindings', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'detailedAnalysis', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'risksAndLimitations', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'recommendations', ''), '[[:space:]]', '', 'g') <> '' AND REGEXP_REPLACE(COALESCE(d.sections->>'references', ''), '[[:space:]]', '', 'g') <> '' FROM deliverables d WHERE d.project_id = p.id ORDER BY d.version DESC LIMIT 1), FALSE) AS report_ready " +
        "FROM research_projects p WHERE p.id = $1",
      [projectId]
    );
    const missing = Object.entries(readiness.rows[0] ?? {})
      .filter(([, ready]) => !ready)
      .map(([gate]) => gate.replace(/_ready$/, ""));
    if (missing.length > 0) {
      throw conflict(
        "WORKFLOW_INCOMPLETE",
        "Complete the required workflow before approval: " + missing.join(", ") + "."
      );
    }

    if (action === "request") {
      if (
        project.rows[0].approval_status === "APPROVED" ||
        project.rows[0].status === "DELIVERED"
      ) {
        throw conflict(
          "INVALID_APPROVAL_STATE",
          "An approved or delivered project cannot return to approval request without a material revision."
        );
      }
      if (project.rows[0].approval_status !== "PENDING") {
        await client.query(
          "UPDATE research_projects SET approval_status = 'PENDING', status = 'APPROVAL_REQUIRED', approved_at = NULL, delivered_at = NULL, updated_at = NOW() WHERE id = $1",
          [projectId]
        );
      }
    } else if (action === "approve") {
      if (!confirmation) {
        throw conflict(
          "EXPLICIT_CONFIRMATION_REQUIRED",
          "Human approval requires an explicit confirmation."
        );
      }
      if (project.rows[0].approval_status !== "PENDING") {
        throw conflict("APPROVAL_NOT_REQUESTED", "Request approval before approving.");
      }
      await client.query(
        "UPDATE research_projects SET approval_status = 'APPROVED', status = 'APPROVED', approved_at = NOW(), updated_at = NOW() WHERE id = $1",
        [projectId]
      );
      await client.query(
        "UPDATE deliverables SET approval_status = 'APPROVED', updated_at = NOW() WHERE id = (SELECT id FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1)",
        [projectId]
      );
    } else {
      if (project.rows[0].status !== "APPROVED") {
        throw conflict(
          "INVALID_APPROVAL_STATE",
          "Only an approved project can be marked delivered."
        );
      }
      if (project.rows[0].approval_status !== "APPROVED") {
        throw conflict("APPROVAL_REQUIRED", "Approve the project before marking it delivered.");
      }
      const finalExport = await client.query(
        "SELECT id FROM project_exports WHERE project_id = $1 AND format = 'ZIP' AND is_current = TRUE ORDER BY created_at DESC LIMIT 1",
        [projectId]
      );
      if (!finalExport.rowCount) {
        throw conflict("DELIVERY_PACKAGE_REQUIRED", "Generate the final ZIP before delivery.");
      }
      await client.query(
        "UPDATE research_projects SET status = 'DELIVERED', delivered_at = NOW(), updated_at = NOW() WHERE id = $1",
        [projectId]
      );
    }

    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
      action:
        action === "request"
          ? "APPROVAL_REQUESTED"
          : action === "approve"
            ? "PROJECT_APPROVED"
            : "PROJECT_DELIVERED",
      resourceType: "research_project",
      resourceId: projectId,
      beforeState: project.rows[0],
      afterState: { action }
    });
    const progress = await refreshProjectProgress(client, projectId);
    const updated = await client.query(
      "SELECT * FROM research_projects WHERE id = $1",
      [projectId]
    );
    return { project: updated.rows[0], progress };
  });
}
