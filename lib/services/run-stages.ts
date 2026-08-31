import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "@/lib/db";
import {
  assertResearchRunTransition,
  assertRunStageTransition,
  type ResearchRunStatus,
  type RunStageStatus
} from "@/lib/domain/research-runs";
import {
  PIPELINE_STAGE_CATALOG,
  getPipelineStageDefinition
} from "@/lib/execution/stages";
import { inputHash } from "@/lib/providers/ai-shared";
import type { AIStage } from "@/lib/providers";
import type { CostStatus } from "@/lib/budgets";
import { writeAuditEvent } from "@/lib/services/audit";
import { conflict, notFound } from "@/lib/services/errors";
import { markGeneratedDomainEffectsNonCurrent } from "@/lib/services/research-domain-effects";
import { sanitizeJobError, type JobErrorClass } from "@/lib/domain/jobs";
import {
  submitJobInTransaction,
  type JobRow
} from "@/lib/services/jobs";
import type {
  ResearchRunRow,
  ResearchRunStageRow
} from "@/lib/services/research-runs";

type LockedStage = {
  run: ResearchRunRow;
  stage: ResearchRunStageRow;
};

export type RunStageJobFence = {
  jobId: string;
  runStageId: string;
  attempt: number;
  workerId: string;
};

async function assertCurrentRunStageJob(
  client: PoolClient,
  runId: string,
  fence: RunStageJobFence
): Promise<void> {
  const current = await client.query(
    `SELECT id FROM jobs
     WHERE id = $1 AND run_id = $2 AND run_stage_id = $3
       AND attempts = $4 AND lease_owner = $5 AND status = 'RUNNING'
       AND lease_expires_at > NOW()
     FOR UPDATE`,
    [fence.jobId, runId, fence.runStageId, fence.attempt, fence.workerId]
  );
  if (!current.rowCount) {
    throw conflict(
      "JOB_LEASE_LOST",
      "The worker no longer owns the current research stage job attempt."
    );
  }
}

async function lockStageProjectFirst(
  client: PoolClient,
  runStageId: string,
  fence?: RunStageJobFence,
  allowDifferentFenceStage = false
): Promise<LockedStage> {
  const identity = await client.query<{ project_id: string; run_id: string }>(
    "SELECT rr.project_id, rrs.run_id FROM research_run_stages rrs JOIN research_runs rr ON rr.id = rrs.run_id WHERE rrs.id = $1",
    [runStageId]
  );
  if (!identity.rows[0]) {
    throw notFound("Research run stage");
  }
  const project = await client.query(
    "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
    [identity.rows[0].project_id]
  );
  if (!project.rowCount) {
    throw notFound("Project");
  }
  if (fence) {
    if (!allowDifferentFenceStage && fence.runStageId !== runStageId) {
      throw conflict(
        "JOB_LEASE_LOST",
        "The job lease does not belong to this research run stage."
      );
    }
    await assertCurrentRunStageJob(client, identity.rows[0].run_id, fence);
  }
  const run = await client.query<ResearchRunRow>(
    "SELECT * FROM research_runs WHERE id = $1 FOR UPDATE",
    [identity.rows[0].run_id]
  );
  const stage = await client.query<ResearchRunStageRow>(
    "SELECT * FROM research_run_stages WHERE id = $1 FOR UPDATE",
    [runStageId]
  );
  if (!run.rows[0] || !stage.rows[0]) {
    throw notFound("Research run stage");
  }
  return { run: run.rows[0], stage: stage.rows[0] };
}

export async function assertRunStageJobFence(
  runStageId: string,
  fence: RunStageJobFence
): Promise<void> {
  await withTransaction(async (client) => {
    await lockStageProjectFirst(client, runStageId, fence);
  });
}

async function assertDependenciesSucceeded(
  client: PoolClient,
  stage: ResearchRunStageRow
): Promise<void> {
  const definition = getPipelineStageDefinition(stage.stage_id as AIStage);
  if (definition.dependencies.length === 0) {
    return;
  }
  const dependencies = await client.query<{ stage_id: string; status: RunStageStatus }>(
    "SELECT DISTINCT ON (stage_id) stage_id, status FROM research_run_stages WHERE run_id = $1 AND stage_id = ANY($2::text[]) ORDER BY stage_id, generation DESC",
    [stage.run_id, [...definition.dependencies]]
  );
  const succeeded = new Set(
    dependencies.rows
      .filter((dependency) => dependency.status === "SUCCEEDED")
      .map((dependency) => dependency.stage_id)
  );
  const missing = definition.dependencies.filter((dependency) => !succeeded.has(dependency));
  if (missing.length > 0) {
    throw conflict(
      "STAGE_DEPENDENCY_INCOMPLETE",
      `Complete these pipeline stages first: ${missing.join(", ")}.`
    );
  }
}

export async function startRunStage(
  runStageId: string,
  fence: RunStageJobFence
): Promise<{
  run: ResearchRunRow;
  stage: ResearchRunStageRow;
}> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, runStageId, fence);
    await assertDependenciesSucceeded(client, locked.stage);
    if (locked.stage.status !== "RUNNING") {
      assertRunStageTransition(locked.stage.status, "RUNNING");
    }
    const stage = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'RUNNING', attempt_count = attempt_count + 1, started_at = COALESCE(started_at, NOW()), completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [runStageId]
    );
    let run = locked.run;
    if (locked.run.status === "QUEUED") {
      assertResearchRunTransition(locked.run.status, "RUNNING");
      const updated = await client.query<ResearchRunRow>(
        "UPDATE research_runs SET status = 'RUNNING', current_stage = $2, started_at = COALESCE(started_at, NOW()), completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
        [locked.run.id, locked.stage.stage_id]
      );
      run = updated.rows[0];
    } else if (locked.run.status !== "RUNNING") {
      throw conflict("RUN_NOT_EXECUTABLE", "The research run is not queued or running.");
    }
    const counted = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET total_attempts = total_attempts + 1, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.run.id]
    );
    run = counted.rows[0];
    await writeAuditEvent(client, {
      projectId: run.project_id,
      actorType: "SYSTEM",
      actorLabel: "Pipeline orchestrator",
      action: "RUN_STAGE_STARTED",
      resourceType: "research_run_stage",
      resourceId: runStageId,
      afterState: { stage: locked.stage.stage_id, attempt: stage.rows[0].attempt_count }
    });
    return { run, stage: stage.rows[0] };
  });
}

export async function recordRunStageProviderAttempt(input: {
  runStageId: string;
  fence: RunStageJobFence;
  providerExecutionId: string;
  inputHash: string;
  provider: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costStatus: CostStatus;
  estimatedCostUsd: number | null;
  durationMs: number;
  outputReference?: unknown;
  errorClass?: JobErrorClass;
  error?: unknown;
}): Promise<{ run: ResearchRunRow; stage: ResearchRunStageRow }> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId, input.fence);
    if (locked.stage.status !== "RUNNING") {
      throw conflict(
        "STAGE_NOT_RUNNING",
        "Provider results can only be recorded for a running stage."
      );
    }
    const previousExecutionId =
      typeof locked.stage.usage?.providerExecutionId === "string"
        ? locked.stage.usage.providerExecutionId
        : null;
    if (previousExecutionId === input.providerExecutionId) {
      return locked;
    }
    const outputJson =
      input.outputReference === undefined
        ? null
        : JSON.stringify(input.outputReference);
    const outputHash =
      input.outputReference === undefined ? null : inputHash(input.outputReference);
    const usage = {
      inputTokens: input.usage.inputTokens ?? 0,
      outputTokens: input.usage.outputTokens ?? 0,
      totalTokens:
        input.usage.totalTokens ??
        (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
      providerExecutionId: input.providerExecutionId
    };
    const sanitized = input.error === undefined ? null : sanitizeJobError(input.error);
    const stage = await client.query<ResearchRunStageRow>(
      `UPDATE research_run_stages
       SET provider = $2, model = $3, usage = $4::jsonb, cost_status = $5,
           estimated_cost = $6, duration_ms = $7,
           output_reference = CASE WHEN $8::jsonb IS NULL THEN output_reference ELSE $8::jsonb END,
           output_hash = COALESCE($9, output_hash), error_class = $10,
           sanitized_error = $11, input_hash = $12,
           updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [
        locked.stage.id,
        input.provider,
        input.model,
        JSON.stringify(usage),
        input.costStatus,
        input.estimatedCostUsd,
        input.durationMs,
        outputJson,
        outputHash,
        input.errorClass ?? null,
        sanitized,
        input.inputHash
      ]
    );
    const run = await client.query<ResearchRunRow>(
      `UPDATE research_runs
       SET total_provider_requests = total_provider_requests + 1,
           total_input_tokens = total_input_tokens + $2,
           total_output_tokens = total_output_tokens + $3,
           estimated_cost = CASE
             WHEN $4::numeric IS NULL THEN estimated_cost
             ELSE COALESCE(estimated_cost, 0) + $4::numeric
           END,
           cost_status = CASE
             WHEN total_provider_requests = 0 THEN $5
             WHEN cost_status = 'UNKNOWN' OR $5 = 'UNKNOWN' THEN 'UNKNOWN'
             WHEN cost_status = 'ESTIMATED' OR $5 = 'ESTIMATED' THEN 'ESTIMATED'
             ELSE 'KNOWN'
           END,
           updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [
        locked.run.id,
        usage.inputTokens,
        usage.outputTokens,
        input.estimatedCostUsd,
        input.costStatus
      ]
    );
    return { run: run.rows[0], stage: stage.rows[0] };
  });
}

export async function queueRunStage(input: {
  runStageId: string;
  fence: RunStageJobFence;
  inputReference: unknown;
  idempotencyKey: string;
}): Promise<{ stage: ResearchRunStageRow; job: JobRow; created: boolean }> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(
      client,
      input.runStageId,
      input.fence,
      true
    );
    if (!(locked.run.status === "QUEUED" || locked.run.status === "RUNNING")) {
      throw conflict("RUN_NOT_EXECUTABLE", "The research run is not queued or running.");
    }
    await assertDependenciesSucceeded(client, locked.stage);
    if (locked.stage.status !== "QUEUED") {
      assertRunStageTransition(locked.stage.status, "QUEUED");
    }
    const definition = getPipelineStageDefinition(locked.stage.stage_id as AIStage);
    const calculatedInputHash = inputHash(input.inputReference);
    const stage = locked.stage.status === "STALE"
      ? await client.query<ResearchRunStageRow>(
          `INSERT INTO research_run_stages (
             id, run_id, stage_id, ordinal, generation, status, pipeline_version,
             prompt_template_version, structured_schema_version,
             input_reference, input_hash
           ) VALUES (
             $1, $2, $3, $4, $5, 'QUEUED', $6, $7, $8, $9::jsonb, $10
           ) RETURNING *`,
          [
            randomUUID(),
            locked.stage.run_id,
            locked.stage.stage_id,
            locked.stage.ordinal,
            locked.stage.generation + 1,
            locked.stage.pipeline_version,
            locked.stage.prompt_template_version,
            locked.stage.structured_schema_version,
            JSON.stringify(input.inputReference),
            calculatedInputHash
          ]
        )
      : await client.query<ResearchRunStageRow>(
          "UPDATE research_run_stages SET status = 'QUEUED', input_reference = $2::jsonb, input_hash = $3, output_reference = NULL, output_hash = NULL, error_class = NULL, sanitized_error = NULL, started_at = NULL, completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
          [input.runStageId, JSON.stringify(input.inputReference), calculatedInputHash]
        );
    const queuedStage = stage.rows[0];
    const submitted = await submitJobInTransaction(client, {
      projectId: locked.run.project_id,
      runId: locked.run.id,
      runStageId: queuedStage.id,
      stage: locked.stage.stage_id,
      jobType: "RESEARCH_PIPELINE_STAGE",
      inputReference: input.inputReference,
      idempotencyKey: input.idempotencyKey,
      correlationId: locked.run.id,
      maxAttempts: Math.min(
        definition.maxAttempts,
        locked.run.budget_snapshot.maxStageAttempts
      ),
      timeoutMs: definition.timeoutMs
    });
    return { stage: queuedStage, job: submitted.job, created: submitted.created };
  });
}

export async function commitRunStage(input: {
  runStageId: string;
  fence: RunStageJobFence;
  idempotencyKey: string;
  outputReference: unknown;
  domainCommit: (client: PoolClient) => Promise<void>;
}): Promise<{
  run: ResearchRunRow;
  stage: ResearchRunStageRow;
  created: boolean;
}> {
  const outputHash = inputHash(input.outputReference);
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId, input.fence);
    const existing = await client.query<{ output_hash: string }>(
      "SELECT output_hash FROM stage_domain_commits WHERE run_stage_id = $1 AND generation = $2 AND idempotency_key = $3",
      [locked.stage.id, locked.stage.generation, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].output_hash !== outputHash) {
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "The stage commit key is already associated with different output."
        );
      }
      return { run: locked.run, stage: locked.stage, created: false };
    }
    if (locked.stage.status !== "RUNNING") {
      throw conflict("STAGE_NOT_RUNNING", "Only a running stage can commit output.");
    }
    await assertDependenciesSucceeded(client, locked.stage);
    await input.domainCommit(client);
    await client.query(
      "INSERT INTO stage_domain_commits (id, run_stage_id, generation, idempotency_key, output_hash, committed_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())",
      [
        randomUUID(),
        locked.stage.id,
        locked.stage.generation,
        input.idempotencyKey,
        outputHash
      ]
    );
    assertRunStageTransition(locked.stage.status, "SUCCEEDED");
    const stage = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'SUCCEEDED', output_reference = $2::jsonb, output_hash = $3, completed_at = NOW(), error_class = NULL, sanitized_error = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.stage.id, JSON.stringify(input.outputReference), outputHash]
    );
    const counts = await client.query<{ succeeded: number; total: number }>(
      "WITH latest AS (SELECT DISTINCT ON (stage_id) status FROM research_run_stages WHERE run_id = $1 ORDER BY stage_id, generation DESC) SELECT COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::integer AS succeeded, COUNT(*)::integer AS total FROM latest",
      [locked.run.id]
    );
    const progress = Math.round((counts.rows[0].succeeded / counts.rows[0].total) * 100);
    const next = PIPELINE_STAGE_CATALOG.find(
      (candidate) => candidate.ordinal === locked.stage.ordinal + 1
    );
    const targetStatus: ResearchRunStatus = next ? "RUNNING" : "QA_REQUIRED";
    if (locked.run.status !== targetStatus) {
      assertResearchRunTransition(locked.run.status, targetStatus);
    }
    const run = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = $2, current_stage = $3, progress = $4, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.run.id, targetStatus, next?.id ?? locked.stage.stage_id, progress]
    );
    await writeAuditEvent(client, {
      projectId: locked.run.project_id,
      actorType: "SYSTEM",
      actorLabel: "Pipeline orchestrator",
      action: "RUN_STAGE_COMMITTED",
      resourceType: "research_run_stage",
      resourceId: locked.stage.id,
      afterState: {
        stage: locked.stage.stage_id,
        generation: locked.stage.generation,
        outputHash,
        progress
      }
    });
    return { run: run.rows[0], stage: stage.rows[0], created: true };
  });
}

export async function blockRunStage(input: {
  runStageId: string;
  fence: RunStageJobFence;
  errorClass: JobErrorClass;
  reason: unknown;
}): Promise<{ run: ResearchRunRow; stage: ResearchRunStageRow }> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId, input.fence);
    if (locked.stage.status === "BLOCKED" && locked.run.status === "BLOCKED") {
      return locked;
    }
    if (locked.stage.status !== "BLOCKED") {
      assertRunStageTransition(locked.stage.status, "BLOCKED");
    }
    const sanitized = sanitizeJobError(input.reason);
    const stage = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'BLOCKED', error_class = $2, sanitized_error = $3, completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.stage.id, input.errorClass, sanitized]
    );
    if (locked.run.status !== "BLOCKED") {
      assertResearchRunTransition(locked.run.status, "BLOCKED");
    }
    const run = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = 'BLOCKED', block_reason = $2, completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.run.id, sanitized]
    );
    await writeAuditEvent(client, {
      projectId: locked.run.project_id,
      actorType: "SYSTEM",
      actorLabel: "Pipeline orchestrator",
      action: "RUN_STAGE_BLOCKED",
      resourceType: "research_run_stage",
      resourceId: locked.stage.id,
      afterState: {
        stage: locked.stage.stage_id,
        errorClass: input.errorClass,
        reason: sanitized
      }
    });
    return { run: run.rows[0], stage: stage.rows[0] };
  });
}

export async function setResearchRunBoundary(input: {
  runStageId: string;
  fence: RunStageJobFence;
  status: Extract<
    ResearchRunStatus,
    "PAUSED" | "QA_REQUIRED" | "APPROVAL_REQUIRED" | "BLOCKED"
  >;
  reason?: string;
}): Promise<ResearchRunRow> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId, input.fence);
    if (locked.stage.status !== "SUCCEEDED") {
      throw conflict(
        "STAGE_NOT_SUCCEEDED",
        "A run boundary can only follow a committed stage."
      );
    }
    if (locked.run.status === input.status) {
      return locked.run;
    }
    assertResearchRunTransition(locked.run.status, input.status);
    const run = await client.query<ResearchRunRow>(
      `UPDATE research_runs
       SET status = $2,
           block_reason = CASE WHEN $2 = 'BLOCKED' THEN $3 ELSE NULL END,
           failure_reason = NULL, updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [locked.run.id, input.status, input.reason ?? null]
    );
    await writeAuditEvent(client, {
      projectId: locked.run.project_id,
      actorType: "SYSTEM",
      actorLabel: "Pipeline orchestrator",
      action: "RESEARCH_RUN_BOUNDARY_REACHED",
      resourceType: "research_run",
      resourceId: locked.run.id,
      beforeState: { status: locked.run.status },
      afterState: {
        status: input.status,
        stage: locked.stage.stage_id,
        reason: input.reason ?? null
      }
    });
    return run.rows[0];
  });
}

export async function failRunStage(input: {
  runStageId: string;
  fence: RunStageJobFence;
  errorClass: JobErrorClass;
  error: unknown;
}): Promise<{ run: ResearchRunRow; stage: ResearchRunStageRow }> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId, input.fence);
    assertRunStageTransition(locked.stage.status, "FAILED");
    const sanitized = sanitizeJobError(input.error);
    const stage = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'FAILED', error_class = $2, sanitized_error = $3, completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.stage.id, input.errorClass, sanitized]
    );
    if (locked.run.status !== "FAILED") {
      assertResearchRunTransition(locked.run.status, "FAILED");
    }
    const run = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = 'FAILED', failure_reason = $2, completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.run.id, sanitized]
    );
    await writeAuditEvent(client, {
      projectId: locked.run.project_id,
      actorType: "SYSTEM",
      actorLabel: "Pipeline orchestrator",
      action: "RUN_STAGE_FAILED",
      resourceType: "research_run_stage",
      resourceId: locked.stage.id,
      afterState: {
        stage: locked.stage.stage_id,
        errorClass: input.errorClass,
        error: sanitized
      }
    });
    return { run: run.rows[0], stage: stage.rows[0] };
  });
}

export async function markDownstreamStagesStale(
  runStageId: string
): Promise<ResearchRunStageRow[]> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, runStageId);
    const downstream = await client.query<ResearchRunStageRow>(
      "SELECT rrs.* FROM research_run_stages rrs JOIN (SELECT DISTINCT ON (stage_id) id FROM research_run_stages WHERE run_id = $1 AND ordinal > $2 ORDER BY stage_id, generation DESC) latest ON latest.id = rrs.id WHERE rrs.status = 'SUCCEEDED' ORDER BY rrs.ordinal FOR UPDATE OF rrs",
      [locked.run.id, locked.stage.ordinal]
    );
    for (const stage of downstream.rows) {
      assertRunStageTransition(stage.status, "STALE");
    }
    if (downstream.rows.length === 0) {
      return [];
    }
    const ids = downstream.rows.map((stage) => stage.id);
    const updated = await client.query<ResearchRunStageRow>(
      "UPDATE research_run_stages SET status = 'STALE', stale_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = ANY($1::text[]) RETURNING *",
      [ids]
    );
    await markGeneratedDomainEffectsNonCurrent(client, ids);
    await client.query(
      "UPDATE research_runs SET progress = (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'SUCCEEDED') / NULLIF(COUNT(*), 0))::integer FROM research_run_stages WHERE run_id = $1), current_stage = $2, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [locked.run.id, locked.stage.stage_id]
    );
    return updated.rows;
  });
}

export async function restartRunStage(input: {
  runStageId: string;
  idempotencyKey: string;
  inputReference: unknown;
  requestedBy: string;
}): Promise<{
  run: ResearchRunRow;
  stage: ResearchRunStageRow;
  job: JobRow;
  created: boolean;
}> {
  return withTransaction(async (client) => {
    const locked = await lockStageProjectFirst(client, input.runStageId);
    const existing = await client.query<{
      job: JobRow;
      stage: ResearchRunStageRow;
    }>(
      `SELECT row_to_json(j.*) AS job, row_to_json(rrs.*) AS stage
       FROM jobs j
       JOIN research_run_stages rrs ON rrs.id = j.run_stage_id
       WHERE j.project_id = $1 AND j.idempotency_key = $2`,
      [locked.run.project_id, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.job.run_id !== locked.run.id ||
        row.stage.stage_id !== locked.stage.stage_id
      ) {
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "The stage restart key belongs to another run stage."
        );
      }
      return { run: locked.run, stage: row.stage, job: row.job, created: false };
    }
    const latest = await client.query<ResearchRunStageRow>(
      "SELECT * FROM research_run_stages WHERE run_id = $1 AND stage_id = $2 ORDER BY generation DESC LIMIT 1 FOR UPDATE",
      [locked.run.id, locked.stage.stage_id]
    );
    if (latest.rows[0]?.id !== locked.stage.id) {
      throw conflict(
        "STALE_STAGE_GENERATION",
        "Restart the latest generation of this run stage."
      );
    }
    if (!(["SUCCEEDED", "FAILED", "BLOCKED", "STALE", "CANCELLED"] as RunStageStatus[]).includes(locked.stage.status)) {
      throw conflict(
        "STAGE_NOT_RESTARTABLE",
        "Only a terminal or stale run stage can be restarted."
      );
    }
    const active = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM jobs WHERE run_id = $1 AND status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED')",
      [locked.run.id]
    );
    if (active.rows[0].count > 0) {
      throw conflict(
        "RUN_HAS_ACTIVE_JOB",
        "Wait for active run jobs to finish before restarting a stage."
      );
    }
    const downstream = await client.query<ResearchRunStageRow>(
      "SELECT rrs.* FROM research_run_stages rrs JOIN (SELECT DISTINCT ON (stage_id) id FROM research_run_stages WHERE run_id = $1 AND ordinal > $2 ORDER BY stage_id, generation DESC) latest_stage ON latest_stage.id = rrs.id WHERE rrs.status = 'SUCCEEDED' ORDER BY rrs.ordinal FOR UPDATE OF rrs",
      [locked.run.id, locked.stage.ordinal]
    );
    if (downstream.rows.length > 0) {
      for (const stage of downstream.rows) {
        assertRunStageTransition(stage.status, "STALE");
      }
      await client.query(
        "UPDATE research_run_stages SET status = 'STALE', stale_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = ANY($1::text[])",
        [downstream.rows.map((stage) => stage.id)]
      );
    }
    await markGeneratedDomainEffectsNonCurrent(client, [
      locked.stage.id,
      ...downstream.rows.map((stage) => stage.id)
    ]);
    const definition = getPipelineStageDefinition(locked.stage.stage_id as AIStage);
    const generation = locked.stage.generation + 1;
    const stage = await client.query<ResearchRunStageRow>(
      `INSERT INTO research_run_stages (
         id, run_id, stage_id, ordinal, generation, status, pipeline_version,
         prompt_template_version, structured_schema_version, input_reference, input_hash
       ) VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        randomUUID(),
        locked.run.id,
        locked.stage.stage_id,
        locked.stage.ordinal,
        generation,
        locked.stage.pipeline_version,
        locked.stage.prompt_template_version,
        locked.stage.structured_schema_version,
        JSON.stringify(input.inputReference),
        inputHash(input.inputReference)
      ]
    );
    if (locked.run.status !== "QUEUED") {
      assertResearchRunTransition(locked.run.status, "QUEUED");
    }
    const run = await client.query<ResearchRunRow>(
      "UPDATE research_runs SET status = 'QUEUED', current_stage = $2, progress = (WITH latest AS (SELECT DISTINCT ON (stage_id) status FROM research_run_stages WHERE run_id = $1 ORDER BY stage_id, generation DESC) SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'SUCCEEDED') / NULLIF(COUNT(*), 0))::integer FROM latest), failure_reason = NULL, block_reason = NULL, completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [locked.run.id, locked.stage.stage_id]
    );
    const submitted = await submitJobInTransaction(client, {
      projectId: locked.run.project_id,
      runId: locked.run.id,
      runStageId: stage.rows[0].id,
      stage: locked.stage.stage_id,
      jobType: "RESEARCH_PIPELINE_STAGE",
      inputReference: input.inputReference,
      idempotencyKey: input.idempotencyKey,
      correlationId: locked.run.id,
      maxAttempts: Math.min(
        definition.maxAttempts,
        locked.run.budget_snapshot.maxStageAttempts
      ),
      timeoutMs: definition.timeoutMs
    });
    await writeAuditEvent(client, {
      projectId: locked.run.project_id,
      actorType: "USER",
      actorLabel: input.requestedBy,
      action: "RUN_STAGE_RESTARTED",
      resourceType: "research_run_stage",
      resourceId: stage.rows[0].id,
      beforeState: {
        stage: locked.stage.stage_id,
        generation: locked.stage.generation
      },
      afterState: {
        stage: locked.stage.stage_id,
        generation,
        staleDownstreamCount: downstream.rows.length,
        idempotencyKey: input.idempotencyKey
      }
    });
    return {
      run: run.rows[0],
      stage: stage.rows[0],
      job: submitted.job,
      created: true
    };
  });
}
