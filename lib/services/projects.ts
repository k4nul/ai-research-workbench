import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db";
import { projectIntakeSchema, reportSectionsSchema, type ProjectIntake } from "@/lib/validation";
import { projectScopeUpdateSchema } from "@/lib/validation";
import {
  LOCAL_USER_AUDIT_ACTOR,
  writeAuditEvent,
  type AuditActor
} from "@/lib/services/audit";
import { conflict, notFound } from "@/lib/services/errors";
import { assessSourceFreshness } from "@/lib/domain/research";
import { refreshProjectProgress } from "@/lib/services/progress";
import { invalidateDownstreamReview } from "@/lib/services/review-state";
import { refreshProjectClaimSupport } from "@/lib/services/ledger";
import { submitJobInTransaction } from "@/lib/services/jobs";

type ProjectRow = {
  id: string;
  workspace_id: string;
  client_id: string | null;
  client_name: string | null;
  name: string;
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
  status: string;
  progress: number;
  approval_status: string;
  scope_approved_at: string | null;
  plan_approved_at: string | null;
  qa_passed_at: string | null;
  approved_at: string | null;
  delivered_at: string | null;
  is_sample: boolean;
  created_at: string;
  updated_at: string;
};

const projectSelect =
  "SELECT p.*, c.organization_name AS client_name FROM research_projects p LEFT JOIN clients c ON c.id = p.client_id";

async function ensureDefaultWorkspace(client: PoolClient): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM workspaces ORDER BY created_at LIMIT 1"
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const id = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, name, default_quality_standard) VALUES ($1, $2, $3::jsonb)",
    [
      id,
      "Local Research Workspace",
      JSON.stringify({ minimumIndependentSources: 2, blockerFreeApproval: true })
    ]
  );
  return id;
}

async function resolveClient(
  client: PoolClient,
  workspaceId: string,
  input: ProjectIntake
): Promise<string | null> {
  if (input.clientId) {
    const existing = await client.query(
      "SELECT id FROM clients WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE",
      [input.clientId, workspaceId]
    );
    if (!existing.rowCount) {
      throw notFound("Client");
    }
    return input.clientId;
  }
  if (!input.clientName) {
    return null;
  }

  const id = randomUUID();
  await client.query(
    "INSERT INTO clients (id, workspace_id, organization_name) VALUES ($1, $2, $3)",
    [id, workspaceId, input.clientName]
  );
  return id;
}

export async function createProject(
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<ProjectRow> {
  const input = projectIntakeSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const workspaceId = await ensureDefaultWorkspace(client);
    const clientId = await resolveClient(client, workspaceId, input);
    const id = randomUUID();
    const deliverableId = randomUUID();
    await client.query(
      "INSERT INTO research_projects (id, workspace_id, client_id, name, core_question, background, purpose, audience, scope, exclusions, jurisdiction, research_date, source_max_age_days, deadline, deliverable_formats, special_requirements) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
      [
        id,
        workspaceId,
        clientId,
        input.name,
        input.coreQuestion,
        input.background || null,
        input.purpose,
        input.audience,
        input.scope,
        input.exclusions || null,
        input.jurisdiction || null,
        input.researchDate,
        input.sourceMaxAgeDays,
        input.deadline ?? null,
        input.deliverableFormats,
        input.specialRequirements || null
      ]
    );
    await client.query(
      "INSERT INTO deliverables (id, project_id, version, title, sections) VALUES ($1, $2, 1, $3, $4::jsonb)",
      [deliverableId, id, input.name, JSON.stringify(reportSectionsSchema.parse({}))]
    );
    await writeAuditEvent(client, {
      projectId: id,
      ...actor,
      action: "PROJECT_CREATED",
      resourceType: "research_project",
      resourceId: id,
      afterState: { name: input.name, mode: input.mode, deliverableId }
    });
    const created = await client.query<ProjectRow>(
      projectSelect + " WHERE p.id = $1",
      [id]
    );
    return created.rows[0];
  });
}

export async function listProjects(options: {
  status?: string;
  queryText?: string;
} = {}): Promise<ProjectRow[]> {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (options.status) {
    values.push(options.status);
    clauses.push("p.status = $" + values.length);
  }
  if (options.queryText) {
    values.push("%" + options.queryText + "%");
    clauses.push("(p.name ILIKE $" + values.length + " OR p.core_question ILIKE $" + values.length + ")");
  }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const result = await query<ProjectRow>(
    projectSelect + where + " ORDER BY p.updated_at DESC",
    values
  );
  return result.rows;
}

export async function getProject(projectId: string): Promise<ProjectRow> {
  const result = await query<ProjectRow>(
    projectSelect + " WHERE p.id = $1",
    [projectId]
  );
  if (!result.rows[0]) {
    throw notFound("Project");
  }
  return result.rows[0];
}

export async function updateProjectScope(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<ProjectRow> {
  const input = projectScopeUpdateSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const before = await client.query<ProjectRow>(
      "SELECT * FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!before.rows[0]) {
      throw notFound("Project");
    }
    const current = before.rows[0];
    const result = await client.query<ProjectRow>(
      "UPDATE research_projects SET core_question = $2, background = $3, purpose = $4, audience = $5, scope = $6, exclusions = $7, jurisdiction = $8, research_date = $9, source_max_age_days = $10, deadline = $11, special_requirements = $12, scope_approved_at = NULL, plan_approved_at = NULL, qa_passed_at = NULL, approved_at = NULL, approval_status = 'NOT_REQUESTED', status = 'SCOPING', updated_at = NOW() WHERE id = $1 RETURNING *",
      [
        projectId,
        input.coreQuestion ?? current.core_question,
        input.background ?? current.background,
        input.purpose ?? current.purpose,
        input.audience ?? current.audience,
        input.scope ?? current.scope,
        input.exclusions ?? current.exclusions,
        input.jurisdiction ?? current.jurisdiction,
        input.researchDate ?? String(current.research_date).slice(0, 10),
        input.sourceMaxAgeDays ?? current.source_max_age_days,
        input.deadline ?? current.deadline,
        input.specialRequirements ?? current.special_requirements
      ]
    );
    await client.query(
      "UPDATE research_plans SET human_approved = FALSE, approved_at = NULL, updated_at = NOW() WHERE project_id = $1",
      [projectId]
    );
    const updated = result.rows[0];
    const sources = await client.query<{ id: string; published_at: string | null }>(
      "SELECT id, published_at::text FROM sources WHERE project_id = $1",
      [projectId]
    );
    for (const source of sources.rows) {
      const freshness = assessSourceFreshness({
        publishedAt: source.published_at,
        researchDate: String(updated.research_date).slice(0, 10),
        maxAgeDays: updated.source_max_age_days
      });
      await client.query(
        "UPDATE sources SET freshness_status = $2, updated_at = NOW() WHERE id = $1",
        [source.id, freshness]
      );
    }
    await refreshProjectClaimSupport(client, projectId);
    await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: "PROJECT_SCOPE_UPDATED",
      resourceType: "research_project",
      resourceId: projectId,
      beforeState: before.rows[0],
      afterState: updated
    });
    await refreshProjectProgress(client, projectId);
    const selected = await client.query<ProjectRow>(
      projectSelect + " WHERE p.id = $1",
      [projectId]
    );
    return selected.rows[0];
  });
}

export async function getProjectBundle(projectId: string): Promise<Record<string, unknown>> {
  const project = await getProject(projectId);
  const [
    questions,
    plans,
    sources,
    evidence,
    claims,
    findings,
    deliverables,
    qaFindings,
    auditEvents
  ] = await Promise.all([
    query("SELECT * FROM research_questions WHERE project_id = $1 ORDER BY priority, created_at", [projectId]),
    query("SELECT * FROM research_plans WHERE project_id = $1 ORDER BY created_at", [projectId]),
    query("SELECT * FROM sources WHERE project_id = $1 ORDER BY accessed_at DESC", [projectId]),
    query(
      "SELECT e.*, s.title AS source_title, s.publisher, s.reliability_grade, s.freshness_status FROM evidence e JOIN sources s ON s.id = e.source_id WHERE s.project_id = $1 AND e.is_current = TRUE ORDER BY e.created_at",
      [projectId]
    ),
    query(
      "SELECT c.*, COALESCE(json_agg(json_build_object('evidenceId', e.id, 'relationship', ce.relationship, 'sourceId', e.source_id)) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS evidence_links FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id = c.id LEFT JOIN evidence e ON e.id = ce.evidence_id AND e.is_current = TRUE WHERE c.project_id = $1 AND c.is_current = TRUE GROUP BY c.id ORDER BY c.importance, c.created_at",
      [projectId]
    ),
    query(
      "SELECT f.*, COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), ARRAY[]::TEXT[]) AS claim_ids FROM findings f LEFT JOIN finding_claims fc ON fc.finding_id = f.id LEFT JOIN claims c ON c.id = fc.claim_id AND c.is_current = TRUE WHERE f.project_id = $1 AND f.is_current = TRUE GROUP BY f.id ORDER BY f.created_at",
      [projectId]
    ),
    query("SELECT * FROM deliverables WHERE project_id = $1 ORDER BY version DESC", [projectId]),
    query(
      "SELECT * FROM qa_findings WHERE project_id = $1 AND is_current = TRUE ORDER BY CASE severity WHEN 'BLOCKER' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, created_at DESC",
      [projectId]
    ),
    query("SELECT * FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100", [projectId])
  ]);
  return {
    project,
    questions: questions.rows,
    plans: plans.rows,
    sources: sources.rows,
    evidence: evidence.rows,
    claims: claims.rows,
    findings: findings.rows,
    deliverables: deliverables.rows,
    qaFindings: qaFindings.rows,
    auditEvents: auditEvents.rows
  };
}

export async function approveScope(
  projectId: string,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<ProjectRow> {
  return withTransaction(async (client) => {
    const before = await client.query<ProjectRow>(
      "SELECT * FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!before.rows[0]) {
      throw notFound("Project");
    }
    if (!["INTAKE", "SCOPING"].includes(before.rows[0].status)) {
      throw conflict(
        "INVALID_PROJECT_STATE",
        "Scope approval is only allowed during intake or scoping."
      );
    }
    await client.query(
      "UPDATE research_projects SET scope_approved_at = NOW(), status = 'PLANNING', updated_at = NOW() WHERE id = $1",
      [projectId]
    );
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: "SCOPE_APPROVED",
      resourceType: "research_project",
      resourceId: projectId,
      beforeState: { status: before.rows[0].status },
      afterState: { status: "PLANNING" }
    });
    await refreshProjectProgress(client, projectId);
    const updated = await client.query<ProjectRow>(projectSelect + " WHERE p.id = $1", [projectId]);
    return updated.rows[0];
  });
}

export async function approvePlan(
  projectId: string,
  planId?: string,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<ProjectRow> {
  return withTransaction(async (client) => {
    const project = await client.query<ProjectRow>(
      "SELECT * FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    if (!["PLANNING", "RESEARCHING"].includes(project.rows[0].status)) {
      throw conflict(
        "INVALID_PROJECT_STATE",
        "Plan approval is only allowed during planning or research."
      );
    }
    if (!project.rows[0].scope_approved_at) {
      throw conflict("SCOPE_APPROVAL_REQUIRED", "Approve the scope before approving a plan.");
    }
    if (planId) {
      const updated = await client.query(
        "UPDATE research_plans SET human_approved = TRUE, approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND project_id = $2",
        [planId, projectId]
      );
      if (!updated.rowCount) {
        throw notFound("Research plan");
      }
    } else {
      await client.query(
        "UPDATE research_plans SET human_approved = TRUE, approved_at = NOW(), updated_at = NOW() WHERE project_id = $1",
        [projectId]
      );
    }
    const planReadiness = await client.query<{
      question_count: string;
      missing_plan_count: string;
      unapproved_count: string;
    }>(
      "SELECT COUNT(*)::text AS question_count, COUNT(*) FILTER (WHERE rp.id IS NULL)::text AS missing_plan_count, COUNT(*) FILTER (WHERE rp.id IS NOT NULL AND rp.human_approved = FALSE)::text AS unapproved_count FROM research_questions rq LEFT JOIN research_plans rp ON rp.question_id = rq.id AND rp.project_id = rq.project_id WHERE rq.project_id = $1",
      [projectId]
    );
    const readiness = planReadiness.rows[0];
    if (
      Number(readiness.question_count) > 0 &&
      Number(readiness.missing_plan_count) === 0 &&
      Number(readiness.unapproved_count) === 0
    ) {
      await client.query(
        "UPDATE research_projects SET plan_approved_at = NOW(), status = 'RESEARCHING', updated_at = NOW() WHERE id = $1",
        [projectId]
      );
    } else if (!planId) {
      throw conflict(
        "PLAN_INCOMPLETE",
        "Every research question must have a human-approved plan."
      );
    }
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: planId ? "PLAN_ITEM_APPROVED" : "PLAN_APPROVED",
      resourceType: "research_plan",
      resourceId: planId
    });
    await refreshProjectProgress(client, projectId);
    const updated = await client.query<ProjectRow>(projectSelect + " WHERE p.id = $1", [projectId]);
    return updated.rows[0];
  });
}

export async function deleteProject(
  projectId: string,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<{ cleanupJobId: string; objectCount: number }> {
  return withTransaction(async (client) => {
    const project = await client.query<{ name: string }>(
      "SELECT name FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    const legalHold = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM storage_objects" +
        " WHERE project_id = $1 AND retention_status = 'LEGAL_HOLD'",
      [projectId]
    );
    if (legalHold.rows[0].count > 0) {
      throw conflict(
        "PROJECT_LEGAL_HOLD",
        "The project has storage objects under legal hold and cannot be deleted."
      );
    }
    const activeJobs = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM jobs
       WHERE project_id = $1 AND status IN (
         'QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAIT', 'CANCELLATION_REQUESTED'
       )
       ORDER BY id FOR UPDATE`,
      [projectId]
    );
    if (
      activeJobs.rows.some((job) =>
        ["CLAIMED", "RUNNING", "CANCELLATION_REQUESTED"].includes(job.status)
      )
    ) {
      throw conflict(
        "PROJECT_JOBS_ACTIVE",
        "Cancel active project jobs, wait for their workers to drain, and retry project deletion."
      );
    }
    const cancelledJobs = await client.query<{ id: string }>(
      `UPDATE jobs SET status = 'CANCELLED', cancellation_requested_at = COALESCE(cancellation_requested_at, NOW()),
        completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
        heartbeat_at = NULL, error_class = 'CANCELLED',
        sanitized_error = 'Project deletion cancelled this job.', updated_at = NOW(),
        version = version + 1
       WHERE project_id = $1 AND status IN ('QUEUED', 'RETRY_WAIT') RETURNING id`,
      [projectId]
    );
    const cancelledRuns = await client.query<{ id: string }>(
      `UPDATE research_runs SET status = 'CANCELLED', cancelled_by = $2,
        completed_at = NOW(), updated_at = NOW(), version = version + 1
       WHERE project_id = $1 AND status NOT IN ('CANCELLED', 'FAILED', 'COMPLETED')
       RETURNING id`,
      [projectId, actor.actorLabel]
    );
    const pendingObjects = await client.query<{ id: string }>(
      `UPDATE storage_objects SET retention_status = 'PENDING_DELETE',
        cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
        last_error = NULL, updated_at = NOW()
       WHERE project_id = $1 AND retention_status IN ('ACTIVE', 'PENDING_DELETE')
       RETURNING id`,
      [projectId]
    );
    await client.query("DELETE FROM research_projects WHERE id = $1", [projectId]);
    const cleanup = await submitJobInTransaction(client, {
      jobType: "STORAGE_CLEANUP",
      inputReference: {
        deleteUntracked: false,
        limit: 1_000,
        objectIds: pendingObjects.rows.map((object) => object.id)
      },
      idempotencyKey: `project-delete:${projectId}:storage-cleanup`,
      priority: 50,
      maxAttempts: 10,
      correlationId: `project-delete:${projectId}`
    });
    await writeAuditEvent(client, {
      ...actor,
      action: "PROJECT_DELETED",
      resourceType: "research_project",
      resourceId: projectId,
      beforeState: {
        name: project.rows[0].name,
        cancelledJobCount: cancelledJobs.rows.length,
        cancelledRunCount: cancelledRuns.rows.length,
        pendingObjectCount: pendingObjects.rows.length
      },
      afterState: { cleanupJobId: cleanup.job.id }
    });
    return {
      cleanupJobId: cleanup.job.id,
      objectCount: pendingObjects.rows.length
    };
  });
}

export async function getDashboard(): Promise<Record<string, unknown>> {
  const [metrics, projects, recentActivity] = await Promise.all([
    query<{
      active_projects: string;
      due_soon: string;
      qa_blocked: string;
      awaiting_approval: string;
      open_gaps: string;
      unsupported_claims: string;
    }>(
      "SELECT COUNT(DISTINCT p.id) FILTER (WHERE p.status NOT IN ('DELIVERED', 'ARCHIVED'))::text AS active_projects, COUNT(DISTINCT p.id) FILTER (WHERE p.deadline BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status NOT IN ('DELIVERED', 'ARCHIVED'))::text AS due_soon, COUNT(DISTINCT p.id) FILTER (WHERE qf.is_current = TRUE AND qf.severity = 'BLOCKER' AND qf.resolution_status <> 'RESOLVED')::text AS qa_blocked, COUNT(DISTINCT p.id) FILTER (WHERE p.approval_status = 'PENDING')::text AS awaiting_approval, (SELECT COUNT(*) FROM research_questions rq WHERE rq.gap_status = 'OPEN')::text AS open_gaps, (SELECT COUNT(*) FROM claims c WHERE c.is_current = TRUE AND c.support_status = 'UNSUPPORTED' AND c.include_in_report = TRUE)::text AS unsupported_claims FROM research_projects p LEFT JOIN qa_findings qf ON qf.project_id = p.id"
    ),
    listProjects(),
    query(
      "SELECT a.*, p.name AS project_name FROM audit_events a LEFT JOIN research_projects p ON p.id = a.project_id ORDER BY a.created_at DESC LIMIT 12"
    )
  ]);
  return {
    metrics: {
      activeProjects: Number(metrics.rows[0]?.active_projects ?? 0),
      dueSoon: Number(metrics.rows[0]?.due_soon ?? 0),
      qaBlocked: Number(metrics.rows[0]?.qa_blocked ?? 0),
      awaitingApproval: Number(metrics.rows[0]?.awaiting_approval ?? 0),
      openGaps: Number(metrics.rows[0]?.open_gaps ?? 0),
      unsupportedClaims: Number(metrics.rows[0]?.unsupported_claims ?? 0)
    },
    projects,
    recentActivity: recentActivity.rows
  };
}
