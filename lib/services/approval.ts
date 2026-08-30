import { withTransaction } from "@/lib/db";
import { conflict, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";
import { refreshProjectProgress } from "@/lib/services/progress";

type ApprovalAction = "request" | "approve" | "deliver";

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

    if (action === "request") {
      await client.query(
        "UPDATE research_projects SET approval_status = 'PENDING', status = 'APPROVAL_REQUIRED', updated_at = NOW() WHERE id = $1",
        [projectId]
      );
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
      if (project.rows[0].approval_status !== "APPROVED") {
        throw conflict("APPROVAL_REQUIRED", "Approve the project before marking it delivered.");
      }
      const finalExport = await client.query(
        "SELECT id FROM project_exports WHERE project_id = $1 AND format = 'ZIP' ORDER BY created_at DESC LIMIT 1",
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
