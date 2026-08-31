import type { QueryResultRow } from "pg";

import type { JobStatus } from "@/lib/domain/jobs";
import type { ResearchRunStatus, RunStageStatus } from "@/lib/domain/research-runs";
import type { AuditActor } from "@/lib/services/audit";
import { getProviderStatuses } from "@/lib/services/provider-runs";
import { query } from "@/lib/db";
import { AppError, notFound } from "@/lib/services/errors";
import {
  manualRetryJob,
  requestJobCancellation
} from "@/lib/services/jobs";
import {
  requestResearchRunCancellation,
  resumeResearchRun
} from "@/lib/services/research-runs";
import { restartRunStage } from "@/lib/services/run-stages";

export type JobOperationsRow = QueryResultRow & {
  id: string;
  project_id: string | null;
  project_name: string | null;
  run_id: string | null;
  run_stage_id: string | null;
  stage: string | null;
  job_type: string;
  status: JobStatus;
  priority: number;
  input_hash: string;
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
  error_class: string | null;
  sanitized_error: string | null;
  cancellation_requested_at: Date | null;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
  version: string;
};

export type JobAttemptOperationsRow = QueryResultRow & {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  status: string;
  error_class: string | null;
  sanitized_error: string | null;
  retry_after_ms: number | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
};

export type JobEventOperationsRow = QueryResultRow & {
  id: string;
  job_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  worker_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
};

export type ResearchRunOperationsRow = QueryResultRow & {
  id: string;
  project_id: string;
  project_name: string;
  mode: string;
  status: ResearchRunStatus;
  scope_revision_id: string | null;
  plan_revision_id: string | null;
  pipeline_version: string;
  request_hash: string;
  current_stage: string | null;
  progress: number;
  total_attempts: number;
  total_provider_requests: number;
  total_search_requests: number;
  total_input_tokens: string | number;
  total_output_tokens: string | number;
  estimated_cost: string | number | null;
  cost_status: string;
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

export type RunStageOperationsRow = QueryResultRow & {
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
  input_hash: string | null;
  output_hash: string | null;
  attempt_count: number;
  usage: Record<string, unknown>;
  cost_status: string;
  estimated_cost: string | number | null;
  duration_ms: number | null;
  error_class: string | null;
  sanitized_error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  stale_at: Date | null;
  version: string;
};

const jobProjection = `
  j.id, j.project_id, p.name AS project_name, j.run_id, j.run_stage_id, j.stage,
  j.job_type, j.status, j.priority, j.input_hash, j.output_hash, j.attempts,
  j.max_attempts, j.scheduled_at, j.claimed_at, j.started_at, j.completed_at,
  j.lease_owner, j.lease_expires_at, j.heartbeat_at, j.timeout_ms,
  j.error_class, j.sanitized_error, j.cancellation_requested_at,
  j.correlation_id, j.created_at, j.updated_at, j.version`;

const runProjection = `
  r.id, r.project_id, p.name AS project_name, r.mode, r.status,
  r.scope_revision_id, r.plan_revision_id, r.pipeline_version, r.request_hash,
  r.current_stage, r.progress, r.total_attempts, r.total_provider_requests,
  r.total_search_requests, r.total_input_tokens, r.total_output_tokens,
  r.estimated_cost, r.cost_status, r.failure_reason, r.block_reason,
  r.created_by, r.cancelled_by, r.started_at, r.completed_at,
  r.created_at, r.updated_at, r.version`;

export async function listJobs(input: {
  projectId?: string;
  status?: JobStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<JobOperationsRow[]> {
  const result = await query<JobOperationsRow>(
    `SELECT ${jobProjection}
       FROM jobs j
       LEFT JOIN research_projects p ON p.id = j.project_id
      WHERE ($1::text IS NULL OR j.project_id = $1)
        AND ($2::text IS NULL OR j.status = $2)
      ORDER BY j.created_at DESC, j.id
      LIMIT $3 OFFSET $4`,
    [input.projectId ?? null, input.status ?? null, input.limit ?? 100, input.offset ?? 0]
  );
  return result.rows;
}

export async function getJobOperationsDetail(
  jobId: string,
  projectId?: string | null
): Promise<{
  job: JobOperationsRow;
  attempts: JobAttemptOperationsRow[];
  events: JobEventOperationsRow[];
}> {
  const scope =
    projectId === undefined ? "ANY" : projectId === null ? "SYSTEM_CLEANUP" : "PROJECT";
  const job = await query<JobOperationsRow>(
    `SELECT ${jobProjection}
       FROM jobs j
       LEFT JOIN research_projects p ON p.id = j.project_id
      WHERE j.id = $1
        AND (
          $2::text = 'ANY'
          OR ($2::text = 'PROJECT' AND j.project_id = $3::text)
          OR (
            $2::text = 'SYSTEM_CLEANUP'
            AND j.project_id IS NULL
            AND j.job_type = 'STORAGE_CLEANUP'
          )
        )`,
    [jobId, scope, typeof projectId === "string" ? projectId : null]
  );
  if (!job.rows[0]) throw notFound("Job");
  const [attempts, events] = await Promise.all([
    query<JobAttemptOperationsRow>(
      "SELECT id, job_id, attempt_number, worker_id, status, error_class, sanitized_error, retry_after_ms, started_at, completed_at, created_at FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number DESC",
      [jobId]
    ),
    query<JobEventOperationsRow>(
      "SELECT id, job_id, event_type, from_status, to_status, worker_id, details, created_at FROM job_events WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200",
      [jobId]
    )
  ]);
  return { job: job.rows[0], attempts: attempts.rows, events: events.rows };
}

async function jobActionWasRecorded(
  jobId: string,
  eventType: string,
  actor: AuditActor,
  idempotencyKey: string
): Promise<boolean> {
  const result = await query(
    "SELECT 1 FROM job_events WHERE job_id = $1 AND event_type = $2 AND details->>'requestedBy' = $3 AND details->>'idempotencyKey' = $4 LIMIT 1",
    [jobId, eventType, actor.actorLabel, idempotencyKey]
  );
  return Boolean(result.rowCount);
}

export async function retryJobForOperator(input: {
  jobId: string;
  projectId: string | null;
  actor: AuditActor;
  idempotencyKey: string;
}): Promise<{ job: JobOperationsRow; replayed: boolean }> {
  await getJobOperationsDetail(input.jobId, input.projectId);
  if (
    await jobActionWasRecorded(
      input.jobId,
      "JOB_MANUAL_RETRY",
      input.actor,
      input.idempotencyKey
    )
  ) {
    return { job: (await getJobOperationsDetail(input.jobId, input.projectId)).job, replayed: true };
  }
  try {
    await manualRetryJob(input.jobId, input.actor.actorLabel, {
      actor: input.actor,
      idempotencyKey: input.idempotencyKey
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "JOB_NOT_RETRYABLE" &&
      (await jobActionWasRecorded(
        input.jobId,
        "JOB_MANUAL_RETRY",
        input.actor,
        input.idempotencyKey
      ))
    ) {
      return { job: (await getJobOperationsDetail(input.jobId, input.projectId)).job, replayed: true };
    }
    throw error;
  }
  return { job: (await getJobOperationsDetail(input.jobId, input.projectId)).job, replayed: false };
}

export async function cancelJobForOperator(input: {
  jobId: string;
  projectId: string | null;
  actor: AuditActor;
  idempotencyKey: string;
}): Promise<{ job: JobOperationsRow; replayed: boolean }> {
  await getJobOperationsDetail(input.jobId, input.projectId);
  if (
    await jobActionWasRecorded(
      input.jobId,
      "JOB_CANCELLATION_REQUESTED",
      input.actor,
      input.idempotencyKey
    )
  ) {
    return { job: (await getJobOperationsDetail(input.jobId, input.projectId)).job, replayed: true };
  }
  await requestJobCancellation(input.jobId, input.actor.actorLabel, {
    actor: input.actor,
    idempotencyKey: input.idempotencyKey
  });
  return { job: (await getJobOperationsDetail(input.jobId, input.projectId)).job, replayed: false };
}

export async function listResearchRuns(input: {
  projectId?: string;
  status?: ResearchRunStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<ResearchRunOperationsRow[]> {
  const result = await query<ResearchRunOperationsRow>(
    `SELECT ${runProjection}
       FROM research_runs r
       JOIN research_projects p ON p.id = r.project_id
      WHERE ($1::text IS NULL OR r.project_id = $1)
        AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.created_at DESC, r.id
      LIMIT $3 OFFSET $4`,
    [input.projectId ?? null, input.status ?? null, input.limit ?? 100, input.offset ?? 0]
  );
  return result.rows;
}

export async function getResearchRunOperationsDetail(
  runId: string,
  projectId?: string
): Promise<{
  run: ResearchRunOperationsRow;
  stages: RunStageOperationsRow[];
  jobs: JobOperationsRow[];
}> {
  const run = await query<ResearchRunOperationsRow>(
    `SELECT ${runProjection}
       FROM research_runs r
       JOIN research_projects p ON p.id = r.project_id
      WHERE r.id = $1 AND ($2::text IS NULL OR r.project_id = $2)`,
    [runId, projectId ?? null]
  );
  if (!run.rows[0]) throw notFound("Research run");
  const [stages, jobs] = await Promise.all([
    query<RunStageOperationsRow>(
      `SELECT id, run_id, stage_id, ordinal, generation, status, pipeline_version,
              prompt_template_version, structured_schema_version, provider, model,
              input_hash, output_hash, attempt_count, usage, cost_status,
              estimated_cost, duration_ms, error_class, sanitized_error,
              started_at, completed_at, stale_at, version
         FROM research_run_stages
        WHERE run_id = $1
        ORDER BY ordinal, generation DESC`,
      [runId]
    ),
    query<JobOperationsRow>(
      `SELECT ${jobProjection}
         FROM jobs j
         LEFT JOIN research_projects p ON p.id = j.project_id
        WHERE j.run_id = $1
        ORDER BY j.created_at DESC`,
      [runId]
    )
  ]);
  return { run: run.rows[0], stages: stages.rows, jobs: jobs.rows };
}

export async function cancelRunForOperator(input: {
  runId: string;
  projectId: string;
  actor: AuditActor;
  idempotencyKey: string;
}): Promise<ReturnType<typeof getResearchRunOperationsDetail>> {
  await getResearchRunOperationsDetail(input.runId, input.projectId);
  if (
    !(await runActionWasRecorded(
      input.runId,
      "RESEARCH_RUN_CANCELLATION_REQUESTED",
      input.actor,
      input.idempotencyKey
    ))
  ) {
    await requestResearchRunCancellation(
      input.runId,
      input.actor.actorLabel,
      input.idempotencyKey
    );
  }
  return getResearchRunOperationsDetail(input.runId, input.projectId);
}

async function runActionWasRecorded(
  runId: string,
  action: string,
  actor: AuditActor,
  idempotencyKey: string
): Promise<boolean> {
  const result = await query(
    "SELECT 1 FROM audit_events WHERE resource_type = 'research_run' AND resource_id = $1 AND action = $2 AND actor_type = $3 AND actor_label = $4 AND after_state->>'idempotencyKey' = $5 LIMIT 1",
    [runId, action, actor.actorType, actor.actorLabel, idempotencyKey]
  );
  return Boolean(result.rowCount);
}

export async function resumeRunForOperator(input: {
  runId: string;
  projectId: string;
  actor: AuditActor;
  idempotencyKey: string;
}): Promise<{ detail: Awaited<ReturnType<typeof getResearchRunOperationsDetail>>; replayed: boolean }> {
  await getResearchRunOperationsDetail(input.runId, input.projectId);
  if (
    await runActionWasRecorded(
      input.runId,
      "RESEARCH_RUN_RESUMED",
      input.actor,
      input.idempotencyKey
    )
  ) {
    return { detail: await getResearchRunOperationsDetail(input.runId, input.projectId), replayed: true };
  }
  try {
    await resumeResearchRun(
      input.runId,
      input.actor.actorLabel,
      input.idempotencyKey
    );
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "RUN_NOT_RESUMABLE" &&
      (await runActionWasRecorded(
        input.runId,
        "RESEARCH_RUN_RESUMED",
        input.actor,
        input.idempotencyKey
      ))
    ) {
      return { detail: await getResearchRunOperationsDetail(input.runId, input.projectId), replayed: true };
    }
    throw error;
  }
  return { detail: await getResearchRunOperationsDetail(input.runId, input.projectId), replayed: false };
}

export async function rerunStageForOperator(input: {
  runId: string;
  runStageId: string;
  projectId: string;
  actor: AuditActor;
  idempotencyKey: string;
}): Promise<Awaited<ReturnType<typeof restartRunStage>>> {
  await getResearchRunOperationsDetail(input.runId, input.projectId);
  const stage = await query<{ input_reference: unknown }>(
    "SELECT input_reference FROM research_run_stages WHERE id = $1 AND run_id = $2",
    [input.runStageId, input.runId]
  );
  if (!stage.rows[0]) throw notFound("Research run stage");
  if (stage.rows[0].input_reference === null) {
    throw new AppError(
      409,
      "STAGE_INPUT_UNAVAILABLE",
      "The stored stage has no replayable input reference."
    );
  }
  return restartRunStage({
    runStageId: input.runStageId,
    idempotencyKey: input.idempotencyKey,
    inputReference: stage.rows[0].input_reference,
    requestedBy: input.actor.actorLabel
  });
}

export async function getProviderOperationsStatus(limit = 20): Promise<{
  providers: ReturnType<typeof getProviderStatuses>;
  executions: QueryResultRow[];
  canaries: QueryResultRow[];
  rateLimits: QueryResultRow[];
}> {
  const [executions, canaries, rateLimits] = await Promise.all([
    query(
      `SELECT id, project_id, run_id, provider, model, operation, status,
              retry_count, input_tokens, output_tokens, total_tokens, cost_status,
              estimated_cost, error_class, sanitized_error, started_at,
              completed_at, latency_ms
         FROM provider_executions
        ORDER BY started_at DESC LIMIT $1`,
      [limit]
    ),
    query(
      `SELECT id, provider, model, status, latency_ms, usage, sanitized_error,
              synthetic_input, created_at
         FROM provider_canary_runs
        ORDER BY created_at DESC LIMIT $1`,
      [limit]
    ),
    query(
      `SELECT provider, operation, window_started_at, window_seconds,
              request_limit, request_count, concurrency_limit, in_flight, updated_at
         FROM provider_rate_windows
        ORDER BY provider, operation`
    )
  ]);
  return {
    providers: getProviderStatuses(),
    executions: executions.rows,
    canaries: canaries.rows,
    rateLimits: rateLimits.rows
  };
}

export async function listProviderCanaryRuns(limit = 50): Promise<QueryResultRow[]> {
  const result = await query(
    `SELECT id, provider, model, status, latency_ms, usage, sanitized_error,
            synthetic_input, created_at
       FROM provider_canary_runs
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function listEvaluationRuns(limit = 50): Promise<QueryResultRow[]> {
  const result = await query(
    `SELECT id, kind, status, pipeline_version, provider, model, prompt_version,
            fixture_count, summary, estimated_cost, started_at, completed_at, created_at
       FROM evaluation_runs
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}
