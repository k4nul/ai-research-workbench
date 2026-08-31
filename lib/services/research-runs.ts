import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { withTransaction } from "@/lib/db";
import {
  assertResearchRunTransition,
  assertRunStageTransition,
  type ResearchRunStatus,
  type RunStageStatus
} from "@/lib/domain/research-runs";
import {
  PIPELINE_STAGE_CATALOG,
  RESEARCH_PIPELINE_VERSION
} from "@/lib/execution/stages";
import { inputHash } from "@/lib/providers/ai-shared";
import { getConfig } from "@/lib/config";
import { selectProviders } from "@/lib/providers";
import {
  DEFAULT_RUN_BUDGET as CENTRAL_DEFAULT_RUN_BUDGET,
  type BudgetSnapshot
} from "@/lib/budgets";
import { ensureApprovalRevision, type ProjectApprovalRow } from "@/lib/services/approval-revisions";
import { writeAuditEvent } from "@/lib/services/audit";
import { conflict, notFound } from "@/lib/services/errors";
import {
  requestJobCancellationInTransaction,
  submitJobInTransaction,
  type JobRow
} from "@/lib/services/jobs";

export type ResearchRunMode = "ASSISTED" | "ORCHESTRATED" | "DRAFT_ONLY";

export type RunBudgetSnapshot = BudgetSnapshot;

export const DEFAULT_RUN_BUDGET: RunBudgetSnapshot = {
  ...CENTRAL_DEFAULT_RUN_BUDGET
};

export type ResearchRunRow = QueryResultRow & {
  id: string;
  project_id: string;
  mode: ResearchRunMode;
  status: ResearchRunStatus;
  scope_revision_id: string | null;
  plan_revision_id: string | null;
  scope_snapshot: Record<string, unknown>;
  plan_snapshot: Record<string, unknown>;
  pipeline_version: string;
  provider_config_snapshot: Record<string, unknown>;
  model_config_snapshot: Record<string, unknown>;
  search_config_snapshot: Record<string, unknown>;
  budget_snapshot: RunBudgetSnapshot;
  request_hash: string;
  idempotency_key: string;
  current_stage: string | null;
  progress: number;
  total_attempts: number;
  total_provider_requests: number;
  total_search_requests: number;
  total_input_tokens: string | number;
  total_output_tokens: string | number;
  estimated_cost: string | number | null;
  cost_status: "KNOWN" | "ESTIMATED" | "UNKNOWN";
  failure_reason: string | null;
  block_reason: string | null;
  created_by: string;
  cancelled_by: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: string;
};

export type ResearchRunStageRow = QueryResultRow & {
  id: string;
  run_id: string;
  stage_id: string;
  ordinal: number;
  generation: number;
  status: RunStageStatus;
  pipeline_version: string;
  prompt_template_version: string;
  structured_schema_version: string;
  provider: string | null;
  model: string | null;
  input_reference: unknown | null;
  input_hash: string | null;
  output_reference: unknown | null;
  output_hash: string | null;
  attempt_count: number;
  usage: Record<string, unknown>;
  cost_status: "KNOWN" | "ESTIMATED" | "UNKNOWN";
  estimated_cost: string | number | null;
  duration_ms: number | null;
  error_class: string | null;
  sanitized_error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  stale_at: Date | null;
  version: string;
};

export type CreateResearchRunInput = {
  projectId: string;
  mode: ResearchRunMode;
  idempotencyKey: string;
  createdBy: string;
  providerConfigSnapshot?: Record<string, unknown>;
  modelConfigSnapshot?: Record<string, unknown>;
  searchConfigSnapshot?: Record<string, unknown>;
  budget?: RunBudgetSnapshot;
  pipelineVersion?: string;
};

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters.`);
  }
  return normalized;
}

function positiveBudgetInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeBudgetInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function validateBudget(value: RunBudgetSnapshot): RunBudgetSnapshot {
  const budget = {
    maxProviderRequests: nonNegativeBudgetInteger(
      value.maxProviderRequests,
      "maxProviderRequests"
    ),
    maxSearchRequests: nonNegativeBudgetInteger(value.maxSearchRequests, "maxSearchRequests"),
    maxInputTokens: nonNegativeBudgetInteger(value.maxInputTokens, "maxInputTokens"),
    maxOutputTokens: nonNegativeBudgetInteger(value.maxOutputTokens, "maxOutputTokens"),
    maxElapsedMs: positiveBudgetInteger(value.maxElapsedMs, "maxElapsedMs"),
    maxStageAttempts: positiveBudgetInteger(value.maxStageAttempts, "maxStageAttempts"),
    maxSources: nonNegativeBudgetInteger(value.maxSources, "maxSources"),
    maxDocumentChunks: nonNegativeBudgetInteger(value.maxDocumentChunks, "maxDocumentChunks"),
    maxEstimatedCostUsd: value.maxEstimatedCostUsd
  };
  if (!Number.isFinite(budget.maxEstimatedCostUsd) || budget.maxEstimatedCostUsd < 0) {
    throw new Error("maxEstimatedCostUsd must be a non-negative finite number.");
  }
  return budget;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function loadRunBundle(
  client: import("pg").PoolClient,
  run: ResearchRunRow,
  created: boolean
): Promise<{
  run: ResearchRunRow;
  stages: ResearchRunStageRow[];
  job: JobRow | null;
  created: boolean;
}> {
  const stages = await client.query<ResearchRunStageRow>(
    "SELECT * FROM research_run_stages WHERE run_id = $1 ORDER BY ordinal, generation",
    [run.id]
  );
  const job = await client.query<JobRow>(
    "SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1",
    [run.id]
  );
  return { run, stages: stages.rows, job: job.rows[0] ?? null, created };
}

export async function createResearchRun(input: CreateResearchRunInput): Promise<{
  run: ResearchRunRow;
  stages: ResearchRunStageRow[];
  job: JobRow | null;
  created: boolean;
}> {
  const projectId = boundedText(input.projectId, "projectId", 500);
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 500);
  const createdBy = boundedText(input.createdBy, "createdBy", 500);
  const pipelineVersion = boundedText(
    input.pipelineVersion ?? RESEARCH_PIPELINE_VERSION,
    "pipelineVersion",
    200
  );
  const budget = validateBudget(input.budget ?? DEFAULT_RUN_BUDGET);
  const config = getConfig();
  const providerSelection = selectProviders({
    demoMode: config.demoMode,
    openAiApiKey: config.openAiApiKey,
    openAiModel: config.openAiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    timeoutMs: config.fetchTimeoutMs
  });
  const providerConfigSnapshot =
    input.providerConfigSnapshot ?? { aiProvider: providerSelection.ai.id };
  const modelConfigSnapshot =
    input.modelConfigSnapshot ?? { aiModel: providerSelection.ai.model };
  const requestedSearchConfigSnapshot = input.searchConfigSnapshot ?? {};
  const searchConfigSnapshot =
    input.searchConfigSnapshot ?? { searchProvider: providerSelection.search.id };

  return withTransaction(async (client) => {
    const project = await client.query<ProjectApprovalRow>(
      "SELECT id, core_question, background, purpose, audience, scope, exclusions, jurisdiction, research_date::text, source_max_age_days, deadline::text, deliverable_formats, special_requirements, scope_approved_at::text, plan_approved_at::text, scope_approved_revision_id, plan_approved_revision_id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    if (!project.rows[0].scope_approved_at) {
      throw conflict(
        "SCOPE_APPROVAL_REQUIRED",
        "Approve the research scope before creating a run."
      );
    }
    if (!project.rows[0].plan_approved_at) {
      throw conflict(
        "PLAN_APPROVAL_REQUIRED",
        "Approve every research plan before creating a run."
      );
    }
    const readiness = await client.query<{
      question_count: number;
      missing_plan_count: number;
      unapproved_count: number;
    }>(
      "SELECT COUNT(*)::integer AS question_count, " +
        "COUNT(*) FILTER (WHERE rp.id IS NULL)::integer AS missing_plan_count, " +
        "COUNT(*) FILTER (WHERE rp.id IS NOT NULL AND rp.human_approved = FALSE)::integer AS unapproved_count " +
        "FROM research_questions rq LEFT JOIN research_plans rp " +
        "ON rp.question_id = rq.id AND rp.project_id = rq.project_id WHERE rq.project_id = $1",
      [projectId]
    );
    const ready = readiness.rows[0];
    if (
      !ready ||
      ready.question_count === 0 ||
      ready.missing_plan_count > 0 ||
      ready.unapproved_count > 0
    ) {
      throw conflict(
        "PLAN_INCOMPLETE",
        "Every research question must have a human-approved plan."
      );
    }

    const scopeRevision = await ensureApprovalRevision(
      client,
      project.rows[0],
      "SCOPE",
      createdBy
    );
    const planRevision = await ensureApprovalRevision(
      client,
      project.rows[0],
      "PLAN",
      createdBy
    );
    const requestSnapshot = {
      mode: input.mode,
      pipelineVersion,
      scopeRevisionId: scopeRevision.id,
      planRevisionId: planRevision.id,
      providerConfigSnapshot,
      modelConfigSnapshot,
      searchConfigSnapshot: requestedSearchConfigSnapshot,
      budget
    };
    const requestHash = inputHash(requestSnapshot);
    const existing = await client.query<ResearchRunRow>(
      "SELECT * FROM research_runs WHERE project_id = $1 AND idempotency_key = $2",
      [projectId, idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key is already associated with different run input."
        );
      }
      return loadRunBundle(client, existing.rows[0], false);
    }

    const runId = randomUUID();
    const firstStage = PIPELINE_STAGE_CATALOG[0];
    const inserted = await client.query<ResearchRunRow>(
      "INSERT INTO research_runs (id, project_id, mode, status, scope_revision_id, plan_revision_id, scope_snapshot, plan_snapshot, pipeline_version, provider_config_snapshot, model_config_snapshot, search_config_snapshot, budget_snapshot, request_hash, idempotency_key, current_stage, progress, created_by) " +
        "VALUES ($1, $2, $3, 'QUEUED', $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, 0, $16) RETURNING *",
      [
        runId,
        projectId,
        input.mode,
        scopeRevision.id,
        planRevision.id,
        json(scopeRevision.snapshot),
        json(planRevision.snapshot),
        pipelineVersion,
        json(providerConfigSnapshot),
        json(modelConfigSnapshot),
        json(searchConfigSnapshot),
        json(budget),
        requestHash,
        idempotencyKey,
        firstStage.id,
        createdBy
      ]
    );
    const initialInput = {
      projectId,
      runId,
      stage: firstStage.id,
      scopeRevisionId: scopeRevision.id,
      planRevisionId: planRevision.id,
      scope: scopeRevision.snapshot,
      plan: planRevision.snapshot
    };
    const stages: ResearchRunStageRow[] = [];
    for (const stage of PIPELINE_STAGE_CATALOG) {
      const stageId = randomUUID();
      const isFirst = stage.id === firstStage.id;
      const stageResult = await client.query<ResearchRunStageRow>(
        "INSERT INTO research_run_stages (id, run_id, stage_id, ordinal, status, pipeline_version, prompt_template_version, structured_schema_version, input_reference, input_hash) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *",
        [
          stageId,
          runId,
          stage.id,
          stage.ordinal,
          isFirst ? "QUEUED" : "PENDING",
          pipelineVersion,
          stage.promptTemplateVersion,
          stage.structuredSchemaVersion,
          isFirst ? json(initialInput) : null,
          isFirst ? inputHash(initialInput) : null
        ]
      );
      stages.push(stageResult.rows[0]);
    }
    const firstStageRow = stages[0];
    const submitted = await submitJobInTransaction(client, {
      projectId,
      runId,
      runStageId: firstStageRow.id,
      stage: firstStage.id,
      jobType: "RESEARCH_PIPELINE_STAGE",
      inputReference: initialInput,
      idempotencyKey: `run:${runId}:stage:${firstStage.id}:generation:1`,
      correlationId: runId,
      maxAttempts: Math.min(firstStage.maxAttempts, budget.maxStageAttempts),
      timeoutMs: firstStage.timeoutMs
    });
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: createdBy,
      action: "RESEARCH_RUN_CREATED",
      resourceType: "research_run",
      resourceId: runId,
      afterState: {
        mode: input.mode,
        pipelineVersion,
        scopeRevisionId: scopeRevision.id,
        planRevisionId: planRevision.id,
        requestHash,
        idempotencyKey
      }
    });
    return {
      run: inserted.rows[0],
      stages,
      job: submitted.job,
      created: true
    };
  });
}

export async function getResearchRun(runId: string): Promise<{
  run: ResearchRunRow;
  stages: ResearchRunStageRow[];
  jobs: JobRow[];
}> {
  return withTransaction(async (client) => {
    const run = await client.query<ResearchRunRow>(
      "SELECT * FROM research_runs WHERE id = $1",
      [runId]
    );
    if (!run.rows[0]) {
      throw notFound("Research run");
    }
    const stages = await client.query<ResearchRunStageRow>(
      "SELECT * FROM research_run_stages WHERE run_id = $1 ORDER BY ordinal, generation",
      [runId]
    );
    const jobs = await client.query<JobRow>(
      "SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at",
      [runId]
    );
    return { run: run.rows[0], stages: stages.rows, jobs: jobs.rows };
  });
}

export async function requestResearchRunCancellation(
  runId: string,
  cancelledBy: string,
  idempotencyKey?: string
): Promise<ResearchRunRow> {
  return withTransaction(async (client) => {
    const identity = await client.query<{ project_id: string }>(
      "SELECT project_id FROM research_runs WHERE id = $1",
      [runId]
    );
    if (!identity.rows[0]) {
      throw notFound("Research run");
    }
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [identity.rows[0].project_id]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
    const runResult = await client.query<ResearchRunRow>(
      "SELECT * FROM research_runs WHERE id = $1 FOR UPDATE",
      [runId]
    );
    const run = runResult.rows[0];
    if (["CANCELLING", "CANCELLED", "COMPLETED", "FAILED"].includes(run.status)) {
      return run;
    }
    const jobs = await client.query<{ id: string; run_stage_id: string | null }>(
      "SELECT id, run_stage_id FROM jobs WHERE run_id = $1 ORDER BY created_at",
      [runId]
    );
    let cooperativeCancellation = false;
    const immediatelyCancelledStages: string[] = [];
    for (const job of jobs.rows) {
      const cancelled = await requestJobCancellationInTransaction(
        client,
        job.id,
        cancelledBy,
        undefined,
        { reconcileLinked: false }
      );
      if (cancelled.status === "CANCELLATION_REQUESTED") {
        cooperativeCancellation = true;
      } else if (cancelled.status === "CANCELLED" && job.run_stage_id) {
        immediatelyCancelledStages.push(job.run_stage_id);
      }
    }
    if (immediatelyCancelledStages.length > 0) {
      await client.query(
        "UPDATE research_run_stages SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = ANY($1::text[]) AND status IN ('PENDING', 'QUEUED')",
        [immediatelyCancelledStages]
      );
    }
    const target: ResearchRunStatus = cooperativeCancellation
      ? "CANCELLING"
      : "CANCELLED";
    assertResearchRunTransition(run.status, target);
    if (target === "CANCELLED") {
      await client.query(
        "UPDATE research_run_stages SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE run_id = $1 AND status IN ('PENDING', 'QUEUED', 'RUNNING')",
        [runId]
      );
    }
    const updated = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = $2, cancelled_by = $3, completed_at = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE NULL END, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [runId, target, cancelledBy]
    );
    await writeAuditEvent(client, {
      projectId: run.project_id,
      actorType: "USER",
      actorLabel: cancelledBy,
      action: "RESEARCH_RUN_CANCELLATION_REQUESTED",
      resourceType: "research_run",
      resourceId: runId,
      beforeState: { status: run.status },
      afterState: { status: target, idempotencyKey }
    });
    return updated.rows[0];
  });
}

export async function finalizeResearchRunCancellation(
  runId: string
): Promise<ResearchRunRow> {
  return withTransaction(async (client) => {
    const identity = await client.query<{ project_id: string }>(
      "SELECT project_id FROM research_runs WHERE id = $1",
      [runId]
    );
    if (!identity.rows[0]) {
      throw notFound("Research run");
    }
    await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [identity.rows[0].project_id]
    );
    const runResult = await client.query<ResearchRunRow>(
      "SELECT * FROM research_runs WHERE id = $1 FOR UPDATE",
      [runId]
    );
    const run = runResult.rows[0];
    if (run.status === "CANCELLED") {
      return run;
    }
    if (run.status !== "CANCELLING") {
      throw conflict("RUN_NOT_CANCELLING", "The research run is not cancelling.");
    }
    const active = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM jobs WHERE run_id = $1 AND status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED')",
      [runId]
    );
    if (active.rows[0].count > 0) {
      throw conflict(
        "RUN_CANCELLATION_PENDING",
        "Workers have not acknowledged every cancellation request."
      );
    }
    assertResearchRunTransition(run.status, "CANCELLED");
    await client.query(
      "UPDATE research_run_stages SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE run_id = $1 AND status IN ('PENDING', 'QUEUED', 'RUNNING')",
      [runId]
    );
    const updated = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [runId]
    );
    return updated.rows[0];
  });
}

export async function resumeResearchRun(
  runId: string,
  requestedBy: string,
  idempotencyKey?: string
): Promise<{ run: ResearchRunRow; stage: ResearchRunStageRow; job: JobRow }> {
  return withTransaction(async (client) => {
    const identity = await client.query<{ project_id: string }>(
      "SELECT project_id FROM research_runs WHERE id = $1",
      [runId]
    );
    if (!identity.rows[0]) {
      throw notFound("Research run");
    }
    await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [identity.rows[0].project_id]
    );
    const runResult = await client.query<ResearchRunRow>(
      "SELECT * FROM research_runs WHERE id = $1 FOR UPDATE",
      [runId]
    );
    const run = runResult.rows[0];
    if (!(["CANCELLED", "FAILED", "PAUSED", "BLOCKED"] as ResearchRunStatus[]).includes(run.status)) {
      throw conflict(
        "RUN_NOT_RESUMABLE",
        "Only cancelled, failed, paused, or blocked runs can be resumed."
      );
    }
    const stageResult = await client.query<ResearchRunStageRow>(
      `SELECT rrs.*
       FROM research_run_stages rrs
       JOIN (
         SELECT DISTINCT ON (stage_id) id
         FROM research_run_stages
         WHERE run_id = $1
         ORDER BY stage_id, generation DESC
       ) latest ON latest.id = rrs.id
       WHERE rrs.status <> 'SUCCEEDED'
       ORDER BY rrs.ordinal
       LIMIT 1
       FOR UPDATE OF rrs`,
      [runId]
    );
    const stage = stageResult.rows[0];
    if (!stage) {
      throw conflict("RUN_ALREADY_COMPLETE", "Every pipeline stage already succeeded.");
    }
    if (stage.status !== "QUEUED") {
      assertRunStageTransition(stage.status, "QUEUED");
    }
    const stageInput = stage.input_reference ?? {
      runId,
      stage: stage.stage_id,
      resume: true
    };
    const updatedStage = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'QUEUED', input_reference = COALESCE(input_reference, $2::jsonb), input_hash = COALESCE(input_hash, $3), error_class = NULL, sanitized_error = NULL, started_at = NULL, completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [stage.id, json(stageInput), inputHash(stageInput)]
    );
    assertResearchRunTransition(run.status, "QUEUED");
    const updatedRun = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = 'QUEUED', current_stage = $2, failure_reason = NULL, block_reason = NULL, cancelled_by = NULL, completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [runId, stage.stage_id]
    );
    const definition = PIPELINE_STAGE_CATALOG.find((item) => item.id === stage.stage_id);
    if (!definition) {
      throw conflict("UNKNOWN_RUN_STAGE", "The stored pipeline stage is not registered.");
    }
    const submitted = await submitJobInTransaction(client, {
      projectId: run.project_id,
      runId,
      runStageId: stage.id,
      stage: stage.stage_id,
      jobType: "RESEARCH_PIPELINE_STAGE",
      inputReference: stageInput,
      idempotencyKey: `run:${runId}:stage:${stage.stage_id}:generation:${stage.generation}:resume:${Number(run.version) + 1}`,
      correlationId: runId,
      maxAttempts: Math.min(definition.maxAttempts, run.budget_snapshot.maxStageAttempts),
      timeoutMs: definition.timeoutMs
    });
    await writeAuditEvent(client, {
      projectId: run.project_id,
      actorType: "USER",
      actorLabel: requestedBy,
      action: "RESEARCH_RUN_RESUMED",
      resourceType: "research_run",
      resourceId: runId,
      beforeState: { status: run.status },
      afterState: { status: "QUEUED", stage: stage.stage_id, idempotencyKey }
    });
    return { run: updatedRun.rows[0], stage: updatedStage.rows[0], job: submitted.job };
  });
}
