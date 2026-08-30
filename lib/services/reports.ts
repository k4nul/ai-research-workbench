import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import {
  deliverableUpdateSchema,
  type ReportSections
} from "@/lib/validation";
import { writeAuditEvent } from "@/lib/services/audit";
import { notFound } from "@/lib/services/errors";
import { refreshProjectProgress } from "@/lib/services/progress";
import { invalidateDownstreamReview } from "@/lib/services/review-state";

export const emptyReportSections: ReportSections = {
  researchPurpose: "",
  executiveSummary: "",
  researchScope: "",
  methodology: "",
  keyFindings: "",
  detailedAnalysis: "",
  comparisonTable: "",
  risksAndLimitations: "",
  recommendations: "",
  references: "",
  appendix: ""
};

export async function getCurrentDeliverable(
  projectId: string
): Promise<Record<string, unknown>> {
  const result = await query<Record<string, unknown>>(
    "SELECT * FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
    [projectId]
  );
  if (result.rows[0]) {
    return result.rows[0];
  }
  const project = await query<{ name: string }>(
    "SELECT name FROM research_projects WHERE id = $1",
    [projectId]
  );
  if (!project.rows[0]) {
    throw notFound("Project");
  }
  return withTransaction(async (client) => {
    const id = randomUUID();
    const created = await client.query(
      "INSERT INTO deliverables (id, project_id, version, title, sections) VALUES ($1, $2, 1, $3, $4::jsonb) RETURNING *",
      [id, projectId, project.rows[0].name, JSON.stringify(emptyReportSections)]
    );
    return created.rows[0];
  });
}

export async function updateDeliverable(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = deliverableUpdateSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const current = await client.query<{
      id: string;
      sections: Record<string, string>;
      title: string;
    }>(
      "SELECT id, sections, title FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
      [projectId]
    );
    if (!current.rows[0]) {
      throw notFound("Deliverable");
    }
    const changedSections = Object.keys(input.sections).filter(
      (key) => current.rows[0].sections[key] !== input.sections[key as keyof ReportSections]
    );
    const result = await client.query(
      "UPDATE deliverables SET title = $2, sections = $3::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *",
      [current.rows[0].id, input.title, JSON.stringify(input.sections)]
    );
    await invalidateDownstreamReview(client, projectId, "QA");
    await client.query(
      "INSERT INTO deliverable_revisions (id, deliverable_id, actor_type, changed_sections, previous_sections, new_sections) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)",
      [
        randomUUID(),
        current.rows[0].id,
        input.actorType,
        changedSections,
        JSON.stringify(current.rows[0].sections),
        JSON.stringify(input.sections)
      ]
    );
    await writeAuditEvent(client, {
      projectId,
      actorType: input.actorType,
      actorLabel: input.actorType === "AI" ? "Configured provider" : "Local user",
      action: "DELIVERABLE_UPDATED",
      resourceType: "deliverable",
      resourceId: current.rows[0].id,
      beforeState: { title: current.rows[0].title },
      afterState: { title: input.title, changedSections }
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function getDeliverableHistory(
  projectId: string
): Promise<Record<string, unknown>[]> {
  const result = await query<Record<string, unknown>>(
    "SELECT r.* FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE d.project_id = $1 ORDER BY r.created_at DESC",
    [projectId]
  );
  return result.rows;
}
