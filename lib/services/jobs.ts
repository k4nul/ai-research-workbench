import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  DEFAULT_JOB_RETRY_POLICY,
  assertJobTransition,
  calculateRetryDelayMs,
  failureJobStatus,
  isTerminalJobStatus,
  parseJobRetryPolicy,
  sanitizeJobError,
  type JobErrorClass,
  type JobRetryPolicy,
  type JobStatus
} from "@/lib/domain/jobs";
import {
  canTransitionResearchRun,
  canTransitionRunStage,
  type ResearchRunStatus,
  type RunStageStatus
} from "@/lib/domain/research-runs";
import { inputHash } from "@/lib/providers/ai-shared";
import { withTransaction } from "@/lib/db";
import { writeAuditEvent, type AuditActor } from "@/lib/services/audit";
import { AppError, conflict, notFound } from "@/lib/services/errors";

export type JobRow = QueryResultRow & {
  id: string;
  project_id: string | null;
  run_id: string | null;
  run_stage_id: string | null;
  stage: string | null;
  job_type: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  idempotency_key: string;
  input_reference: unknown;
  input_hash: string;
  output_reference: unknown | null;
  output_hash: string | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: Date;
  claimed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  timeout_ms: number;
  retry_policy: unknown;
  error_class: JobErrorClass | null;
  sanitized_error: string | null;
  cancellation_requested_at: Date | null;
  parent_job_id: string | null;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
  version: string;
};

export type SubmitJobInput = {
  projectId?: string;
  runId?: string;
  runStageId?: string;
  stage?: string;
  jobType: string;
  inputReference: unknown;
  idempotencyKey: string;
  correlationId?: string;
  parentJobId?: string;
  priority?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  retryPolicy?: JobRetryPolicy;
  scheduledAt?: Date;
};

export type JobOperatorAudit = {
  actor: AuditActor;
  idempotencyKey: string;
};

export const JOB_INPUT_MAX_BYTES = 4 * 1_024 * 1_024;
export const JOB_OUTPUT_MAX_BYTES = 4 * 1_024 * 1_024;

type JobReferenceKind = "input" | "output";

type OwnedJob = JobRow & { lease_current: boolean };

type LinkedResearchRun = QueryResultRow & {
  id: string;
  project_id: string;
  status: ResearchRunStatus;
};

type LinkedResearchRunStage = QueryResultRow & {
  id: string;
  stage_id: string;
  status: RunStageStatus;
};

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AppError(
      400,
      "INVALID_JOB_CONFIGURATION",
      `${name} must be an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AppError(
      400,
      "INVALID_JOB_CONFIGURATION",
      `${name} must contain 1-${maximum} characters.`
    );
  }
  return normalized;
}

function boundedRunIds(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length > 1_000) {
    throw new AppError(
      400,
      "INVALID_JOB_CONFIGURATION",
      "runIds must contain at most 1000 entries."
    );
  }
  const runIds = values.map((runId) => boundedText(runId, "runId", 500));
  if (new Set(runIds).size !== runIds.length) {
    throw new AppError(
      400,
      "INVALID_JOB_CONFIGURATION",
      "runIds must not contain duplicates."
    );
  }
  return runIds;
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Value has no JSON representation.");
    }
    return serialized;
  } catch {
    throw new AppError(
      400,
      "INVALID_JOB_INPUT",
      "Job input must be JSON serializable."
    );
  }
}

export function serializeJobReference(
  value: unknown,
  kind: JobReferenceKind
): string {
  const maximumBytes = kind === "input" ? JOB_INPUT_MAX_BYTES : JOB_OUTPUT_MAX_BYTES;
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) {
      throw new Error("Value has no JSON representation.");
    }
    serialized = candidate;
  } catch {
    throw new AppError(
      400,
      kind === "input" ? "INVALID_JOB_INPUT" : "INVALID_JOB_OUTPUT",
      `Job ${kind} must be JSON serializable.`
    );
  }
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes > maximumBytes) {
    throw new AppError(
      413,
      kind === "input" ? "JOB_INPUT_TOO_LARGE" : "JOB_OUTPUT_TOO_LARGE",
      `Job ${kind} exceeds the ${maximumBytes}-byte persistence limit.`,
      { actualBytes, maximumBytes }
    );
  }
  return serialized;
}

async function recordJobEvent(
  client: PoolClient,
  input: {
    jobId: string;
    eventType: string;
    fromStatus?: JobStatus;
    toStatus?: JobStatus;
    workerId?: string;
    details?: unknown;
  }
): Promise<void> {
  await client.query(
    "INSERT INTO job_events (id, job_id, event_type, from_status, to_status, worker_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    [
      randomUUID(),
      input.jobId,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.workerId ?? null,
      json(input.details ?? {})
    ]
  );
}

async function lockJobProjectFirst(
  client: PoolClient,
  jobId: string
): Promise<JobRow> {
  const identity = await client.query<{ project_id: string | null }>(
    "SELECT project_id FROM jobs WHERE id = $1",
    [jobId]
  );
  if (!identity.rows[0]) {
    throw notFound("Job");
  }
  if (identity.rows[0].project_id) {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [identity.rows[0].project_id]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
  }
  const job = await client.query<JobRow>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [
    jobId
  ]);
  if (!job.rows[0]) {
    throw notFound("Job");
  }
  return job.rows[0];
}

async function lockOwnedJob(
  client: PoolClient,
  jobId: string,
  workerId: string,
  allowedStatuses: readonly JobStatus[],
  expectedVersion?: string
): Promise<OwnedJob> {
  const locked = await lockJobProjectFirst(client, jobId);
  const result = await client.query<OwnedJob>(
    "SELECT j.*, (j.lease_expires_at > NOW()) AS lease_current FROM jobs j WHERE j.id = $1",
    [locked.id]
  );
  const job = result.rows[0];
  if (
    !job ||
    job.lease_owner !== workerId ||
    !job.lease_current ||
    !allowedStatuses.includes(job.status)
  ) {
    throw conflict(
      "JOB_LEASE_LOST",
      "The worker no longer owns a current lease for this job."
    );
  }
  if (expectedVersion !== undefined && job.version !== expectedVersion) {
    throw conflict("STALE_JOB_VERSION", "The job changed after it was read.");
  }
  return job;
}

async function lockLinkedResearchState(
  client: PoolClient,
  job: JobRow
): Promise<{
  run: LinkedResearchRun;
  stage: LinkedResearchRunStage | null;
} | null> {
  if (!job.run_id) {
    return null;
  }
  const run = await client.query<LinkedResearchRun>(
    "SELECT id, project_id, status FROM research_runs WHERE id = $1 FOR UPDATE",
    [job.run_id]
  );
  if (!run.rows[0]) {
    throw conflict(
      "JOB_RUN_LINK_BROKEN",
      "The job no longer has a complete research run linkage."
    );
  }
  if (!job.run_stage_id) {
    return { run: run.rows[0], stage: null };
  }
  const stage = await client.query<LinkedResearchRunStage>(
    "SELECT id, stage_id, status FROM research_run_stages WHERE id = $1 AND run_id = $2 FOR UPDATE",
    [job.run_stage_id, job.run_id]
  );
  if (!stage.rows[0]) {
    throw conflict(
      "JOB_RUN_LINK_BROKEN",
      "The job no longer has a complete research run linkage."
    );
  }
  return { run: run.rows[0], stage: stage.rows[0] };
}

async function reconcileLinkedJobFailure(
  client: PoolClient,
  job: JobRow,
  input: { errorClass: JobErrorClass; sanitizedError: string }
): Promise<void> {
  const linked = await lockLinkedResearchState(client, job);
  if (
    !linked ||
    !linked.stage ||
    !(linked.stage.status === "QUEUED" || linked.stage.status === "RUNNING") ||
    !canTransitionRunStage(linked.stage.status, "FAILED")
  ) {
    return;
  }
  await client.query(
    "UPDATE research_run_stages SET status = 'FAILED', error_class = $2, sanitized_error = $3, completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1",
    [linked.stage.id, input.errorClass, input.sanitizedError]
  );
  let runStatus = linked.run.status;
  if (
    linked.run.status !== "FAILED" &&
    canTransitionResearchRun(linked.run.status, "FAILED")
  ) {
    await client.query(
      "UPDATE research_runs SET status = 'FAILED', failure_reason = $2, completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1",
      [linked.run.id, input.sanitizedError]
    );
    runStatus = "FAILED";
  }
  await writeAuditEvent(client, {
    projectId: linked.run.project_id,
    actorType: "SYSTEM",
    actorLabel: "Durable job reconciler",
    action: "RUN_STAGE_JOB_FAILED",
    resourceType: "research_run_stage",
    resourceId: linked.stage.id,
    beforeState: {
      jobStatus: job.status,
      stageStatus: linked.stage.status,
      runStatus: linked.run.status
    },
    afterState: {
      jobStatus: job.status,
      stageStatus: "FAILED",
      runStatus,
      errorClass: input.errorClass
    }
  });
}

async function reconcileLinkedJobCancellation(
  client: PoolClient,
  job: JobRow,
  requestedBy: string
): Promise<void> {
  const linked = await lockLinkedResearchState(client, job);
  if (!linked || ["COMPLETED", "FAILED", "CANCELLED"].includes(linked.run.status)) {
    return;
  }
  let runStatus = linked.run.status;
  if (
    runStatus !== "CANCELLING" &&
    canTransitionResearchRun(runStatus, "CANCELLING")
  ) {
    await client.query(
      "UPDATE research_runs SET status = 'CANCELLING', cancelled_by = COALESCE(cancelled_by, $2), completed_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [linked.run.id, requestedBy]
    );
    runStatus = "CANCELLING";
  }
  if (job.status !== "CANCELLED") {
    return;
  }
  if (
    linked.stage &&
    ["PENDING", "QUEUED", "RUNNING"].includes(linked.stage.status) &&
    canTransitionRunStage(linked.stage.status, "CANCELLED")
  ) {
    await client.query(
      "UPDATE research_run_stages SET status = 'CANCELLED', completed_at = NOW(), error_class = 'CANCELLED', sanitized_error = 'The linked durable job was cancelled.', updated_at = NOW(), version = version + 1 WHERE id = $1",
      [linked.stage.id]
    );
  }
  const active = await client.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM jobs WHERE run_id = $1 AND status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED')",
    [linked.run.id]
  );
  if (active.rows[0].count > 0 || runStatus !== "CANCELLING") {
    return;
  }
  await client.query(
    "UPDATE research_run_stages SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE run_id = $1 AND status IN ('PENDING', 'QUEUED', 'RUNNING')",
    [linked.run.id]
  );
  await client.query(
    "UPDATE research_runs SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1",
    [linked.run.id]
  );
  await writeAuditEvent(client, {
    projectId: linked.run.project_id,
    actorType: "SYSTEM",
    actorLabel: "Durable job reconciler",
    action: "RESEARCH_RUN_CANCELLATION_ACKNOWLEDGED",
    resourceType: "research_run",
    resourceId: linked.run.id,
    beforeState: { status: linked.run.status },
    afterState: { status: "CANCELLED", acknowledgedJobId: job.id }
  });
}

export async function submitJobInTransaction(
  client: PoolClient,
  input: SubmitJobInput
): Promise<{ job: JobRow; created: boolean }> {
  const id = randomUUID();
  const projectId = input.projectId?.trim() || null;
  const jobType = boundedText(input.jobType, "jobType", 200);
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 500);
  const correlationId = boundedText(input.correlationId ?? id, "correlationId", 500);
  const priority = boundedInteger(input.priority ?? 0, "priority", -1_000, 1_000);
  const maxAttempts = boundedInteger(input.maxAttempts ?? 3, "maxAttempts", 1, 100);
  const timeoutMs = boundedInteger(
    input.timeoutMs ?? 300_000,
    "timeoutMs",
    1,
    86_400_000
  );
  const retryPolicy = parseJobRetryPolicy(
    input.retryPolicy ?? DEFAULT_JOB_RETRY_POLICY
  );
  const inputJson = serializeJobReference(input.inputReference, "input");
  const normalizedInput: unknown = JSON.parse(inputJson);
  const calculatedInputHash = inputHash(normalizedInput);
  const scheduledAt = input.scheduledAt ?? null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    throw new AppError(400, "INVALID_JOB_CONFIGURATION", "scheduledAt must be valid.");
  }

  const inserted = await client.query<JobRow>(
    "INSERT INTO jobs (id, project_id, run_id, run_stage_id, stage, job_type, payload, status, priority, idempotency_key, input_reference, input_hash, max_attempts, scheduled_at, timeout_ms, retry_policy, parent_job_id, correlation_id) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'QUEUED', $8, $9, $7::jsonb, $10, $11, COALESCE($12, NOW()), $13, $14::jsonb, $15, $16) " +
      "ON CONFLICT DO NOTHING RETURNING *",
    [
      id,
      projectId,
      input.runId ?? null,
      input.runStageId ?? null,
      input.stage ?? null,
      jobType,
      inputJson,
      priority,
      idempotencyKey,
      calculatedInputHash,
      maxAttempts,
      scheduledAt,
      timeoutMs,
      json(retryPolicy),
      input.parentJobId ?? null,
      correlationId
    ]
  );
  if (inserted.rows[0]) {
    await recordJobEvent(client, {
      jobId: id,
      eventType: "JOB_SUBMITTED",
      toStatus: "QUEUED",
      details: { idempotencyKey, correlationId }
    });
    return { job: inserted.rows[0], created: true };
  }

  const existing = await client.query<JobRow>(
    "SELECT * FROM jobs WHERE project_id IS NOT DISTINCT FROM $1 AND idempotency_key = $2",
    [projectId, idempotencyKey]
  );
  const job = existing.rows[0];
  if (!job) {
    throw conflict(
      "JOB_SUBMISSION_CONFLICT",
      "The job could not be submitted because a related constraint changed."
    );
  }
  if (
    job.job_type !== jobType ||
    job.input_hash !== calculatedInputHash ||
    job.run_id !== (input.runId ?? null) ||
    job.run_stage_id !== (input.runStageId ?? null)
  ) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key is already associated with different job input."
    );
  }
  return { job, created: false };
}

export async function submitJob(
  input: SubmitJobInput
): Promise<{ job: JobRow; created: boolean }> {
  return withTransaction(async (client) => {
    if (input.projectId) {
      const project = await client.query(
        "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
        [input.projectId]
      );
      if (!project.rowCount) {
        throw notFound("Project");
      }
    }
    return submitJobInTransaction(client, input);
  });
}

export async function getJob(jobId: string): Promise<JobRow> {
  return withTransaction(async (client) => {
    const result = await client.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [jobId]);
    if (!result.rows[0]) {
      throw notFound("Job");
    }
    return result.rows[0];
  });
}

export async function claimJobs(input: {
  workerId: string;
  limit?: number;
  leaseDurationMs: number;
  jobTypes?: readonly string[];
  runIds?: readonly string[];
}): Promise<JobRow[]> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  const limit = boundedInteger(input.limit ?? 1, "limit", 1, 100);
  const leaseDurationMs = boundedInteger(
    input.leaseDurationMs,
    "leaseDurationMs",
    1,
    86_400_000
  );
  const jobTypes = input.jobTypes?.map((jobType) =>
    boundedText(jobType, "jobType", 200)
  );
  const runIds = boundedRunIds(input.runIds);
  if (jobTypes && new Set(jobTypes).size !== jobTypes.length) {
    throw new AppError(
      400,
      "INVALID_JOB_CONFIGURATION",
      "jobTypes must not contain duplicates."
    );
  }
  if (jobTypes?.length === 0 || runIds?.length === 0) {
    return [];
  }
  return withTransaction(async (client) => {
    const claimed = await client.query<JobRow & { previous_status: JobStatus }>(
      "WITH candidates AS (" +
        " SELECT id, status AS previous_status FROM jobs" +
        " WHERE status IN ('QUEUED', 'RETRY_WAIT')" +
        " AND scheduled_at <= NOW() AND attempts < max_attempts" +
        " AND ($4::text[] IS NULL OR job_type = ANY($4::text[]))" +
        " AND ($5::text[] IS NULL OR run_id = ANY($5::text[]))" +
        " ORDER BY priority DESC, scheduled_at, id" +
        " FOR UPDATE SKIP LOCKED LIMIT $1" +
        ") UPDATE jobs j SET" +
        " status = 'CLAIMED', attempts = j.attempts + 1," +
        " claimed_at = NOW(), lease_owner = $2," +
        " lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')," +
        " heartbeat_at = NOW(), error_class = NULL, sanitized_error = NULL," +
        " updated_at = NOW(), version = j.version + 1" +
        " FROM candidates c WHERE j.id = c.id" +
        " RETURNING j.*, c.previous_status",
      [limit, workerId, leaseDurationMs, jobTypes ?? null, runIds ?? null]
    );
    for (const job of claimed.rows) {
      assertJobTransition(job.previous_status, "CLAIMED");
      await client.query(
        "INSERT INTO job_attempts (id, job_id, attempt_number, worker_id, status) VALUES ($1, $2, $3, $4, 'CLAIMED')",
        [randomUUID(), job.id, job.attempts, workerId]
      );
      await recordJobEvent(client, {
        jobId: job.id,
        eventType: "JOB_CLAIMED",
        fromStatus: job.previous_status,
        toStatus: "CLAIMED",
        workerId,
        details: { attempt: job.attempts, leaseDurationMs }
      });
    }
    return claimed.rows;
  });
}

export async function startJob(
  jobId: string,
  workerId: string,
  expectedVersion?: string
): Promise<JobRow> {
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(
      client,
      jobId,
      boundedText(workerId, "workerId", 500),
      ["CLAIMED"],
      expectedVersion
    );
    assertJobTransition(job.status, "RUNNING");
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), heartbeat_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id]
    );
    await client.query(
      "UPDATE job_attempts SET status = 'RUNNING' WHERE job_id = $1 AND attempt_number = $2",
      [job.id, job.attempts]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: "JOB_STARTED",
      fromStatus: job.status,
      toStatus: "RUNNING",
      workerId
    });
    return updated.rows[0];
  });
}

export async function heartbeatJob(input: {
  jobId: string;
  workerId: string;
  leaseDurationMs: number;
}): Promise<JobRow> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  const leaseDurationMs = boundedInteger(
    input.leaseDurationMs,
    "leaseDurationMs",
    1,
    86_400_000
  );
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(client, input.jobId, workerId, [
      "CLAIMED",
      "RUNNING",
      "CANCELLATION_REQUESTED"
    ]);
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET heartbeat_at = NOW(), lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'), updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id, leaseDurationMs]
    );
    return updated.rows[0];
  });
}

export async function completeJob(input: {
  jobId: string;
  workerId: string;
  outputReference: unknown;
}): Promise<JobRow> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  const outputJson = serializeJobReference(input.outputReference, "output");
  const normalizedOutput: unknown = JSON.parse(outputJson);
  const outputHash = inputHash(normalizedOutput);
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(client, input.jobId, workerId, ["RUNNING"]);
    assertJobTransition(job.status, "SUCCEEDED");
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = 'SUCCEEDED', output_reference = $2::jsonb, output_hash = $3, completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id, outputJson, outputHash]
    );
    await client.query(
      "UPDATE job_attempts SET status = 'SUCCEEDED', completed_at = NOW() WHERE job_id = $1 AND attempt_number = $2",
      [job.id, job.attempts]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: "JOB_SUCCEEDED",
      fromStatus: job.status,
      toStatus: "SUCCEEDED",
      workerId,
      details: { outputHash }
    });
    return updated.rows[0];
  });
}

export async function failJob(input: {
  jobId: string;
  workerId: string;
  errorClass: JobErrorClass;
  error: unknown;
  retryAfterMs?: number;
  random?: () => number;
}): Promise<JobRow> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(client, input.jobId, workerId, [
      "CLAIMED",
      "RUNNING"
    ]);
    const target = failureJobStatus({
      errorClass: input.errorClass,
      attempts: job.attempts,
      maxAttempts: job.max_attempts
    });
    assertJobTransition(job.status, target);
    const retryDelayMs =
      target === "RETRY_WAIT"
        ? calculateRetryDelayMs({
            attempt: job.attempts,
            policy: parseJobRetryPolicy(job.retry_policy),
            retryAfterMs: input.retryAfterMs,
            random: input.random
          })
        : null;
    const sanitizedError = sanitizeJobError(input.error);
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = $2, scheduled_at = CASE WHEN $2 = 'RETRY_WAIT' THEN NOW() + ($3::bigint * INTERVAL '1 millisecond') ELSE scheduled_at END, completed_at = CASE WHEN $2 IN ('FAILED', 'DEAD_LETTER') THEN NOW() ELSE NULL END, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_class = $4, sanitized_error = $5, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id, target, retryDelayMs ?? 0, input.errorClass, sanitizedError]
    );
    await client.query(
      "UPDATE job_attempts SET status = $3, error_class = $4, sanitized_error = $5, retry_after_ms = $6, completed_at = NOW() WHERE job_id = $1 AND attempt_number = $2",
      [job.id, job.attempts, target, input.errorClass, sanitizedError, retryDelayMs]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: target === "RETRY_WAIT" ? "JOB_RETRY_SCHEDULED" : "JOB_FAILED",
      fromStatus: job.status,
      toStatus: target,
      workerId,
      details: { errorClass: input.errorClass, retryDelayMs }
    });
    if (target === "FAILED" || target === "DEAD_LETTER") {
      await reconcileLinkedJobFailure(client, updated.rows[0], {
        errorClass: input.errorClass,
        sanitizedError
      });
    }
    return updated.rows[0];
  });
}

export async function requestJobCancellationInTransaction(
  client: PoolClient,
  jobId: string,
  requestedBy = "operator",
  audit?: JobOperatorAudit,
  options: { reconcileLinked?: boolean } = {}
): Promise<JobRow> {
  const job = await lockJobProjectFirst(client, jobId);
  if (isTerminalJobStatus(job.status) || job.status === "CANCELLATION_REQUESTED") {
    return job;
  }
  const target: JobStatus = ["QUEUED", "RETRY_WAIT"].includes(job.status)
    ? "CANCELLED"
    : "CANCELLATION_REQUESTED";
  assertJobTransition(job.status, target);
  const updated = await client.query<JobRow>(
    "UPDATE jobs SET status = $2, cancellation_requested_at = NOW(), completed_at = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE completed_at END, lease_owner = CASE WHEN $2 = 'CANCELLED' THEN NULL ELSE lease_owner END, lease_expires_at = CASE WHEN $2 = 'CANCELLED' THEN NULL ELSE lease_expires_at END, heartbeat_at = CASE WHEN $2 = 'CANCELLED' THEN NULL ELSE heartbeat_at END, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
    [job.id, target]
  );
  await recordJobEvent(client, {
    jobId: job.id,
    eventType: "JOB_CANCELLATION_REQUESTED",
    fromStatus: job.status,
    toStatus: target,
    details: {
      requestedBy,
      ...(audit ? { idempotencyKey: audit.idempotencyKey } : {})
    }
  });
  if (audit) {
    await writeAuditEvent(client, {
      projectId: job.project_id ?? undefined,
      ...audit.actor,
      action: "JOB_CANCELLATION_REQUESTED",
      resourceType: "job",
      resourceId: job.id,
      beforeState: { status: job.status },
      afterState: { status: target, idempotencyKey: audit.idempotencyKey }
    });
  }
  if (options.reconcileLinked !== false) {
    await reconcileLinkedJobCancellation(client, updated.rows[0], requestedBy);
  }
  return updated.rows[0];
}

export async function requestJobCancellation(
  jobId: string,
  requestedBy = "operator",
  audit?: JobOperatorAudit
): Promise<JobRow> {
  return withTransaction((client) =>
    requestJobCancellationInTransaction(client, jobId, requestedBy, audit)
  );
}

export async function acknowledgeJobCancellation(input: {
  jobId: string;
  workerId: string;
}): Promise<JobRow> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(client, input.jobId, workerId, [
      "CANCELLATION_REQUESTED"
    ]);
    assertJobTransition(job.status, "CANCELLED");
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = 'CANCELLED', completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_class = 'CANCELLED', sanitized_error = 'Cancellation acknowledged by worker.', updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id]
    );
    await client.query(
      "UPDATE job_attempts SET status = 'CANCELLED', error_class = 'CANCELLED', completed_at = NOW() WHERE job_id = $1 AND attempt_number = $2",
      [job.id, job.attempts]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: "JOB_CANCELLED",
      fromStatus: job.status,
      toStatus: "CANCELLED",
      workerId
    });
    await reconcileLinkedJobCancellation(
      client,
      updated.rows[0],
      "Cancellation acknowledged by worker"
    );
    return updated.rows[0];
  });
}

export async function releaseJobLease(input: {
  jobId: string;
  workerId: string;
}): Promise<JobRow> {
  const workerId = boundedText(input.workerId, "workerId", 500);
  return withTransaction(async (client) => {
    const job = await lockOwnedJob(client, input.jobId, workerId, [
      "CLAIMED",
      "RUNNING",
      "CANCELLATION_REQUESTED"
    ]);
    const target: JobStatus =
      job.status === "CANCELLATION_REQUESTED" ? "CANCELLED" : "RETRY_WAIT";
    assertJobTransition(job.status, target);
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = $2, scheduled_at = CASE WHEN $2 = 'RETRY_WAIT' THEN NOW() ELSE scheduled_at END, completed_at = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE NULL END, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_class = CASE WHEN $2 = 'CANCELLED' THEN 'CANCELLED' ELSE error_class END, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id, target]
    );
    await client.query(
      "UPDATE job_attempts SET status = $3, completed_at = NOW() WHERE job_id = $1 AND attempt_number = $2",
      [job.id, job.attempts, target]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: target === "CANCELLED" ? "JOB_CANCELLED" : "JOB_LEASE_RELEASED",
      fromStatus: job.status,
      toStatus: target,
      workerId
    });
    if (target === "CANCELLED") {
      await reconcileLinkedJobCancellation(
        client,
        updated.rows[0],
        "Cancellation completed during worker shutdown"
      );
    }
    return updated.rows[0];
  });
}

export async function recoverExpiredJobs(input: {
  limit?: number;
  random?: () => number;
  runIds?: readonly string[];
} = {}): Promise<JobRow[]> {
  const limit = boundedInteger(input.limit ?? 100, "limit", 1, 1_000);
  const runIds = boundedRunIds(input.runIds);
  if (runIds?.length === 0) {
    return [];
  }
  const candidates = await withTransaction((client) =>
    client.query<{ id: string }>(
      "SELECT id FROM jobs WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED') AND lease_expires_at <= NOW() AND ($2::text[] IS NULL OR run_id = ANY($2::text[])) ORDER BY lease_expires_at, id LIMIT $1",
      [limit, runIds ?? null]
    )
  );
  const recovered: JobRow[] = [];
  for (const candidate of candidates.rows) {
    try {
      const result = await withTransaction(async (client) => {
        const locked = await lockJobProjectFirst(client, candidate.id);
        const current = await client.query<JobRow & { lease_expired: boolean }>(
          "SELECT j.*, (j.lease_expires_at <= NOW()) AS lease_expired FROM jobs j WHERE j.id = $1",
          [locked.id]
        );
        const job = current.rows[0];
        if (
          !job?.lease_expired ||
          (runIds !== undefined &&
            (!job.run_id || !runIds.includes(job.run_id))) ||
          !(["CLAIMED", "RUNNING", "CANCELLATION_REQUESTED"] as JobStatus[]).includes(
            job.status
          )
        ) {
          return null;
        }
        const target: JobStatus =
          job.status === "CANCELLATION_REQUESTED"
            ? "CANCELLED"
            : job.attempts < job.max_attempts
              ? "RETRY_WAIT"
              : "DEAD_LETTER";
        assertJobTransition(job.status, target);
        const retryDelayMs =
          target === "RETRY_WAIT"
            ? calculateRetryDelayMs({
                attempt: Math.max(1, job.attempts),
                policy: parseJobRetryPolicy(job.retry_policy),
                random: input.random
              })
            : null;
        const updated = await client.query<JobRow>(
          "UPDATE jobs SET status = $2, scheduled_at = CASE WHEN $2 = 'RETRY_WAIT' THEN NOW() + ($3::bigint * INTERVAL '1 millisecond') ELSE scheduled_at END, completed_at = CASE WHEN $2 IN ('CANCELLED', 'DEAD_LETTER') THEN NOW() ELSE NULL END, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_class = CASE WHEN $2 = 'CANCELLED' THEN 'CANCELLED' ELSE 'UNKNOWN' END, sanitized_error = CASE WHEN $2 = 'CANCELLED' THEN 'Cancellation completed after the worker lease expired.' ELSE 'Worker lease expired before completion.' END, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
          [job.id, target, retryDelayMs ?? 0]
        );
        await client.query(
          "UPDATE job_attempts SET status = 'LEASE_EXPIRED', error_class = CASE WHEN $3 = 'CANCELLED' THEN 'CANCELLED' ELSE 'UNKNOWN' END, sanitized_error = 'Worker lease expired before completion.', retry_after_ms = $4, completed_at = NOW() WHERE job_id = $1 AND attempt_number = $2",
          [job.id, job.attempts, target, retryDelayMs]
        );
        await recordJobEvent(client, {
          jobId: job.id,
          eventType: "JOB_LEASE_EXPIRED",
          fromStatus: job.status,
          toStatus: target,
          workerId: job.lease_owner ?? undefined,
          details: { retryDelayMs }
        });
        if (target === "DEAD_LETTER") {
          await reconcileLinkedJobFailure(client, updated.rows[0], {
            errorClass: "UNKNOWN",
            sanitizedError: "Worker lease expired before completion."
          });
        } else if (target === "CANCELLED") {
          await reconcileLinkedJobCancellation(
            client,
            updated.rows[0],
            "Cancellation completed after worker lease expiry"
          );
        }
        return updated.rows[0];
      });
      if (result) {
        recovered.push(result);
      }
    } catch (error) {
      if (!(error instanceof AppError && error.code === "NOT_FOUND")) {
        throw error;
      }
    }
  }
  return recovered;
}

export async function manualRetryJob(
  jobId: string,
  requestedBy = "operator",
  audit?: JobOperatorAudit
): Promise<JobRow> {
  return withTransaction(async (client) => {
    const job = await lockJobProjectFirst(client, jobId);
    if (job.run_stage_id || job.job_type === "RESEARCH_PIPELINE_STAGE") {
      throw conflict(
        "PIPELINE_STAGE_RESTART_REQUIRED",
        "Retry research pipeline work by restarting the latest stage generation."
      );
    }
    if (!(["FAILED", "DEAD_LETTER"] as JobStatus[]).includes(job.status)) {
      throw conflict(
        "JOB_NOT_RETRYABLE",
        "Only failed or dead-letter jobs can be retried manually."
      );
    }
    assertJobTransition(job.status, "QUEUED");
    const updated = await client.query<JobRow>(
      "UPDATE jobs SET status = 'QUEUED', max_attempts = attempts + 1, scheduled_at = NOW(), claimed_at = NULL, started_at = NULL, completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_class = NULL, sanitized_error = NULL, cancellation_requested_at = NULL, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *",
      [job.id]
    );
    await recordJobEvent(client, {
      jobId: job.id,
      eventType: "JOB_MANUAL_RETRY",
      fromStatus: job.status,
      toStatus: "QUEUED",
      details: {
        requestedBy,
        ...(audit ? { idempotencyKey: audit.idempotencyKey } : {})
      }
    });
    if (audit) {
      await writeAuditEvent(client, {
        projectId: job.project_id ?? undefined,
        ...audit.actor,
        action: "JOB_MANUAL_RETRY",
        resourceType: "job",
        resourceId: job.id,
        beforeState: { status: job.status },
        afterState: { status: "QUEUED", idempotencyKey: audit.idempotencyKey }
      });
    }
    return updated.rows[0];
  });
}
