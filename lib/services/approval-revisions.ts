import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { withTransaction } from "@/lib/db";
import { inputHash } from "@/lib/providers/ai-shared";
import { conflict, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";

export type ApprovalRevisionKind = "SCOPE" | "PLAN";

export type ApprovalRevisionRow = QueryResultRow & {
  id: string;
  project_id: string;
  kind: ApprovalRevisionKind;
  revision_number: number;
  snapshot: Record<string, unknown>;
  content_hash: string;
  approved_at: Date;
  created_by: string;
  created_at: Date;
};

type ProjectApprovalRow = QueryResultRow & {
  id: string;
  core_question: string;
  background: string | null;
  purpose: string;
  audience: string;
  scope: string;
  exclusions: string | null;
  jurisdiction: string | null;
  research_date: string;
  source_max_age_days: number;
  deadline: string | null;
  deliverable_formats: string[];
  special_requirements: string | null;
  scope_approved_at: string | null;
  plan_approved_at: string | null;
  scope_approved_revision_id: string | null;
  plan_approved_revision_id: string | null;
};

function scopeSnapshot(project: ProjectApprovalRow): Record<string, unknown> {
  return {
    coreQuestion: project.core_question,
    background: project.background,
    purpose: project.purpose,
    audience: project.audience,
    scope: project.scope,
    exclusions: project.exclusions,
    jurisdiction: project.jurisdiction,
    researchDate: project.research_date,
    sourceMaxAgeDays: project.source_max_age_days,
    deadline: project.deadline,
    deliverableFormats: project.deliverable_formats,
    specialRequirements: project.special_requirements
  };
}

async function planSnapshot(
  client: PoolClient,
  projectId: string
): Promise<Record<string, unknown>> {
  const result = await client.query<{
    id: string;
    parent_id: string | null;
    question: string;
    priority: string;
    completion_criteria: string;
    plan_id: string | null;
    search_strategy: string | null;
    search_queries: string[] | null;
    primary_source_types: string[] | null;
    secondary_source_types: string[] | null;
    comparison_targets: string[] | null;
    expected_output: string | null;
    assigned_stage: string | null;
    completion_condition: string | null;
    expected_risks: string[] | null;
    research_gap: string | null;
    human_approved: boolean | null;
    approved_at: string | null;
  }>(
    "SELECT rq.id, rq.parent_id, rq.question, rq.priority, rq.completion_criteria, " +
      "rp.id AS plan_id, rp.search_strategy, rp.search_queries, rp.primary_source_types, " +
      "rp.secondary_source_types, rp.comparison_targets, rp.expected_output, " +
      "rp.assigned_stage, rp.completion_condition, rp.expected_risks, rp.research_gap, " +
      "rp.human_approved, rp.approved_at::text " +
      "FROM research_questions rq " +
      "LEFT JOIN research_plans rp ON rp.question_id = rq.id AND rp.project_id = rq.project_id " +
      "WHERE rq.project_id = $1 ORDER BY rq.created_at, rq.id",
    [projectId]
  );
  return {
    questions: result.rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      question: row.question,
      priority: row.priority,
      completionCriteria: row.completion_criteria,
      plan: row.plan_id
        ? {
            id: row.plan_id,
            searchStrategy: row.search_strategy,
            searchQueries: row.search_queries,
            primarySourceTypes: row.primary_source_types,
            secondarySourceTypes: row.secondary_source_types,
            comparisonTargets: row.comparison_targets,
            expectedOutput: row.expected_output,
            assignedStage: row.assigned_stage,
            completionCondition: row.completion_condition,
            expectedRisks: row.expected_risks,
            researchGap: row.research_gap,
            humanApproved: row.human_approved,
            approvedAt: row.approved_at
          }
        : null
    }))
  };
}

export async function ensureApprovalRevision(
  client: PoolClient,
  project: ProjectApprovalRow,
  kind: ApprovalRevisionKind,
  createdBy: string
): Promise<ApprovalRevisionRow> {
  const approvedAt =
    kind === "SCOPE" ? project.scope_approved_at : project.plan_approved_at;
  if (!approvedAt) {
    throw conflict(
      kind === "SCOPE" ? "SCOPE_APPROVAL_REQUIRED" : "PLAN_APPROVAL_REQUIRED",
      `A current ${kind.toLowerCase()} approval is required before capturing a revision.`
    );
  }
  const snapshot =
    kind === "SCOPE" ? scopeSnapshot(project) : await planSnapshot(client, project.id);
  const contentHash = inputHash(snapshot);
  const existing = await client.query<ApprovalRevisionRow>(
    "SELECT * FROM approval_revisions WHERE project_id = $1 AND kind = $2 AND content_hash = $3",
    [project.id, kind, contentHash]
  );
  let revision = existing.rows[0];
  if (!revision) {
    const next = await client.query<{ revision_number: number }>(
      "SELECT COALESCE(MAX(revision_number), 0)::integer + 1 AS revision_number FROM approval_revisions WHERE project_id = $1 AND kind = $2",
      [project.id, kind]
    );
    const inserted = await client.query<ApprovalRevisionRow>(
      "INSERT INTO approval_revisions (id, project_id, kind, revision_number, snapshot, content_hash, approved_at, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *",
      [
        randomUUID(),
        project.id,
        kind,
        next.rows[0].revision_number,
        JSON.stringify(snapshot),
        contentHash,
        approvedAt,
        createdBy
      ]
    );
    revision = inserted.rows[0];
    await writeAuditEvent(client, {
      projectId: project.id,
      actorType: "SYSTEM",
      actorLabel: "Approval revision service",
      action: `${kind}_APPROVAL_REVISION_CAPTURED`,
      resourceType: "approval_revision",
      resourceId: revision.id,
      afterState: {
        kind,
        revisionNumber: revision.revision_number,
        contentHash
      }
    });
  }
  const column =
    kind === "SCOPE" ? "scope_approved_revision_id" : "plan_approved_revision_id";
  await client.query(
    `UPDATE research_projects SET ${column} = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, revision.id]
  );
  return revision;
}

export async function captureApprovalRevision(
  projectId: string,
  kind: ApprovalRevisionKind,
  createdBy = "Local user"
): Promise<ApprovalRevisionRow> {
  return withTransaction(async (client) => {
    const project = await client.query<ProjectApprovalRow>(
      "SELECT id, core_question, background, purpose, audience, scope, exclusions, jurisdiction, research_date::text, source_max_age_days, deadline::text, deliverable_formats, special_requirements, scope_approved_at::text, plan_approved_at::text, scope_approved_revision_id, plan_approved_revision_id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    return ensureApprovalRevision(client, project.rows[0], kind, createdBy);
  });
}

export type { ProjectApprovalRow };
