import { randomUUID } from "node:crypto";
import { structuredLog, type LogLevel } from "@/lib/observability/log";
import {
  acknowledgeJobCancellation,
  claimJobs,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  recoverExpiredJobs,
  releaseJobLease,
  startJob,
  type JobRow
} from "@/lib/services/jobs";
import { sanitizeJobError, type JobErrorClass } from "@/lib/domain/jobs";
import { AppError } from "@/lib/services/errors";
import type { JobHandler } from "@/worker/handlers";

export class JobExecutionError extends Error {
  constructor(
    message: string,
    public readonly errorClass: JobErrorClass,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "JobExecutionError";
  }
}

export type WorkerLog = (entry: Record<string, unknown>) => void;

export function classifyJobExecutionError(error: unknown): JobErrorClass {
  if (error instanceof JobExecutionError) {
    return error.errorClass;
  }
  if (
    error instanceof AppError &&
    ["INVALID_JOB_OUTPUT", "JOB_OUTPUT_TOO_LARGE"].includes(error.code)
  ) {
    return "NON_RETRYABLE_VALIDATION";
  }
  return "UNKNOWN";
}

export type DurableWorkerOptions = {
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  recoveryBatchSize?: number;
  shutdownGraceMs?: number;
  jobTypeConcurrency?: Readonly<Record<string, number>>;
  runIds?: readonly string[];
  log?: WorkerLog;
};

type ActiveExecution = {
  job: JobRow;
  controller: AbortController;
  shutdownRequested: boolean;
  promise: Promise<void>;
};

function integerOption(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function runIdOption(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length > 1_000) {
    throw new Error("runIds must contain at most 1000 entries.");
  }
  const runIds = values.map((value) => value.trim());
  if (runIds.some((value) => !value || value.length > 500)) {
    throw new Error("Each runId must contain 1-500 characters.");
  }
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("runIds must not contain duplicates.");
  }
  return runIds;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function defaultLog(entry: Record<string, unknown>): void {
  const level = ["debug", "info", "warn", "error"].includes(String(entry.level))
    ? (entry.level as LogLevel)
    : "info";
  const detailKeys = ["count", "handlerCount", "status"] as const;
  const details = Object.fromEntries(
    detailKeys.flatMap((key) => {
      const value = entry[key];
      return typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean" || value === null
        ? [[key, value] as const]
        : [];
    })
  );
  structuredLog(level, String(entry.event ?? "worker.event"), {
    service: "worker",
    workerId: typeof entry.workerId === "string" ? entry.workerId : undefined,
    requestId: typeof entry.requestId === "string" ? entry.requestId : undefined,
    correlationId:
      typeof entry.correlationId === "string" ? entry.correlationId : undefined,
    jobId: typeof entry.jobId === "string" ? entry.jobId : undefined,
    jobType: typeof entry.jobType === "string" ? entry.jobType : undefined,
    runId: typeof entry.runId === "string" ? entry.runId : undefined,
    projectId: typeof entry.projectId === "string" ? entry.projectId : undefined,
    stage: typeof entry.stage === "string" ? entry.stage : undefined,
    provider: typeof entry.provider === "string" ? entry.provider : undefined,
    durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
    retry: typeof entry.retry === "number" ? entry.retry : undefined,
    errorCode: typeof entry.errorCode === "string" ? entry.errorCode : undefined
  }, details);
}

export class DurableWorker {
  readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recoveryBatchSize: number;
  private readonly shutdownGraceMs: number;
  private readonly jobTypeConcurrency: ReadonlyMap<string, number>;
  private readonly runIds: readonly string[] | undefined;
  private readonly log: WorkerLog;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly polls = new Set<Promise<number>>();
  private readonly pollController = new AbortController();
  private stopping = false;

  constructor(
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    options: DurableWorkerOptions = {}
  ) {
    this.workerId = options.workerId?.trim() || `worker-${process.pid}-${randomUUID()}`;
    this.concurrency = integerOption(options.concurrency ?? 2, "concurrency", 1, 100);
    this.pollIntervalMs = integerOption(
      options.pollIntervalMs ?? 1_000,
      "pollIntervalMs",
      10,
      60_000
    );
    this.leaseDurationMs = integerOption(
      options.leaseDurationMs ?? 30_000,
      "leaseDurationMs",
      1_000,
      3_600_000
    );
    this.heartbeatIntervalMs = integerOption(
      options.heartbeatIntervalMs ?? 10_000,
      "heartbeatIntervalMs",
      100,
      1_200_000
    );
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("heartbeatIntervalMs must be shorter than leaseDurationMs.");
    }
    this.recoveryBatchSize = integerOption(
      options.recoveryBatchSize ?? 100,
      "recoveryBatchSize",
      1,
      1_000
    );
    this.shutdownGraceMs = integerOption(
      options.shutdownGraceMs ?? 30_000,
      "shutdownGraceMs",
      0,
      3_600_000
    );
    const jobTypeConcurrency = new Map<string, number>();
    for (const [rawJobType, rawLimit] of Object.entries(
      options.jobTypeConcurrency ?? {}
    )) {
      const jobType = rawJobType.trim();
      if (!jobType || !this.handlers.has(jobType)) {
        throw new Error(`jobTypeConcurrency contains an unregistered job type: ${rawJobType}.`);
      }
      const limit = integerOption(rawLimit, `${jobType} concurrency`, 1, 100);
      jobTypeConcurrency.set(jobType, Math.min(limit, this.concurrency));
    }
    this.jobTypeConcurrency = jobTypeConcurrency;
    this.runIds = runIdOption(options.runIds);
    this.log = options.log ?? defaultLog;
  }

  get activeJobCount(): number {
    return this.active.size;
  }

  get configuredConcurrency(): number {
    return this.concurrency;
  }

  configuredJobTypeConcurrency(jobType: string): number {
    return this.jobTypeConcurrency.get(jobType) ?? this.concurrency;
  }

  async runOnce(): Promise<number> {
    if (this.stopping) {
      return 0;
    }
    const poll = this.pollOnce();
    this.polls.add(poll);
    try {
      return await poll;
    } finally {
      this.polls.delete(poll);
    }
  }

  private async pollOnce(): Promise<number> {
    const recovered = await recoverExpiredJobs({
      limit: this.recoveryBatchSize,
      ...(this.runIds === undefined ? {} : { runIds: this.runIds })
    });
    if (recovered.length > 0) {
      this.log({
        level: "warn",
        service: "worker",
        workerId: this.workerId,
        event: "jobs.recovered",
        count: recovered.length
      });
    }
    if (this.stopping) {
      return 0;
    }
    if (this.handlers.size === 0) {
      return 0;
    }
    const capacity = this.concurrency - this.active.size;
    if (capacity <= 0) {
      return 0;
    }
    let claimed = 0;
    while (claimed < capacity) {
      const activeByType = new Map<string, number>();
      for (const execution of this.active.values()) {
        activeByType.set(
          execution.job.job_type,
          (activeByType.get(execution.job.job_type) ?? 0) + 1
        );
      }
      const eligibleJobTypes = [...this.handlers.keys()].filter(
        (jobType) =>
          (activeByType.get(jobType) ?? 0) <
          this.configuredJobTypeConcurrency(jobType)
      );
      if (eligibleJobTypes.length === 0) break;
      const [job] = await claimJobs({
        workerId: this.workerId,
        limit: 1,
        leaseDurationMs: this.leaseDurationMs,
        jobTypes: eligibleJobTypes,
        ...(this.runIds === undefined ? {} : { runIds: this.runIds })
      });
      if (!job) break;
      if (this.stopping) {
        await releaseJobLease({ jobId: job.id, workerId: this.workerId });
        break;
      }
      const controller = new AbortController();
      const execution: ActiveExecution = {
        job,
        controller,
        shutdownRequested: false,
        promise: Promise.resolve()
      };
      execution.promise = this.execute(execution).finally(() => {
        this.active.delete(job.id);
      });
      this.active.set(job.id, execution);
      claimed += 1;
    }
    return claimed;
  }

  async run(): Promise<void> {
    this.log({
      level: "info",
      service: "worker",
      workerId: this.workerId,
      event: "worker.started",
      handlerCount: this.handlers.size
    });
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        this.log({
          level: "error",
          service: "worker",
          workerId: this.workerId,
          event: "worker.poll_failed",
          errorCode: error instanceof Error ? error.name : "UNKNOWN"
        });
      }
      if (!this.stopping) {
        await delay(this.pollIntervalMs, this.pollController.signal);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.pollController.abort();
    await Promise.allSettled([...this.polls]);
    const initial = [...this.active.values()];
    if (initial.length === 0) {
      return;
    }
    const settled = Promise.allSettled(initial.map((execution) => execution.promise));
    if (this.shutdownGraceMs > 0) {
      await Promise.race([settled, delay(this.shutdownGraceMs)]);
    }
    for (const execution of this.active.values()) {
      execution.shutdownRequested = true;
      execution.controller.abort(new Error("Worker is shutting down."));
    }
    await Promise.allSettled([...this.active.values()].map((execution) => execution.promise));
    this.log({
      level: "info",
      service: "worker",
      workerId: this.workerId,
      event: "worker.stopped"
    });
  }

  private async execute(execution: ActiveExecution): Promise<void> {
    let job = execution.job;
    const executionStartedAt = Date.now();
    let heartbeatBusy = false;
    let cancellationRequested = false;
    let leaseLost = false;
    let timedOut = false;
    const handler = this.handlers.get(job.job_type);
    try {
      job = await startJob(job.id, this.workerId, job.version);
      this.log({
        level: "info",
        service: "worker",
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.job_type,
        correlationId: job.correlation_id,
        runId: job.run_id,
        projectId: job.project_id,
        stage: job.stage,
        retry: Math.max(0, job.attempts - 1),
        event: "job.started"
      });
      if (!handler) {
        const failed = await failJob({
          jobId: job.id,
          workerId: this.workerId,
          errorClass: "NON_RETRYABLE_VALIDATION",
          error: `No handler is registered for ${job.job_type}.`
        });
        this.log({
          level: "error",
          service: "worker",
          workerId: this.workerId,
          jobId: job.id,
          jobType: job.job_type,
          correlationId: job.correlation_id,
          runId: job.run_id,
          projectId: job.project_id,
          stage: job.stage,
          durationMs: Date.now() - executionStartedAt,
          retry: Math.max(0, job.attempts - 1),
          errorCode: "NON_RETRYABLE_VALIDATION",
          status: failed.status,
          event: "job.failed"
        });
        return;
      }
      const timeout = setTimeout(() => {
        timedOut = true;
        execution.controller.abort(
          new JobExecutionError("Job execution timed out.", "RETRYABLE_TIMEOUT")
        );
      }, job.timeout_ms);
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || execution.controller.signal.aborted) {
          return;
        }
        heartbeatBusy = true;
        void heartbeatJob({
          jobId: job.id,
          workerId: this.workerId,
          leaseDurationMs: this.leaseDurationMs
        })
          .then((updated) => {
            if (updated.status === "CANCELLATION_REQUESTED") {
              cancellationRequested = true;
              execution.controller.abort(
                new JobExecutionError(
                  "Job cancellation was requested.",
                  "CANCELLED"
                )
              );
            }
          })
          .catch(() => {
            leaseLost = true;
            execution.controller.abort(new Error("Job lease was lost."));
          })
          .finally(() => {
            heartbeatBusy = false;
          });
      }, this.heartbeatIntervalMs);
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const rejectForAbort = () => {
          reject(
            execution.controller.signal.reason instanceof Error
              ? execution.controller.signal.reason
              : new Error("Job execution was aborted.")
          );
        };
        if (execution.controller.signal.aborted) {
          rejectForAbort();
          return;
        }
        execution.controller.signal.addEventListener("abort", rejectForAbort, {
          once: true
        });
      });
      try {
        const handlerPromise = Promise.resolve().then(() =>
          handler({
            job,
            workerId: this.workerId,
            signal: execution.controller.signal
          })
        );
        void handlerPromise.catch(() => undefined);
        const output = await Promise.race([handlerPromise, abortPromise]);
        if (cancellationRequested) {
          await acknowledgeJobCancellation({ jobId: job.id, workerId: this.workerId });
          this.log({
            level: "info",
            service: "worker",
            workerId: this.workerId,
            jobId: job.id,
            jobType: job.job_type,
            correlationId: job.correlation_id,
            runId: job.run_id,
            projectId: job.project_id,
            stage: job.stage,
            durationMs: Date.now() - executionStartedAt,
            retry: Math.max(0, job.attempts - 1),
            errorCode: "CANCELLED",
            status: "CANCELLED",
            event: "job.cancelled"
          });
        } else if (execution.shutdownRequested) {
          await releaseJobLease({ jobId: job.id, workerId: this.workerId });
          this.log({
            level: "info",
            service: "worker",
            workerId: this.workerId,
            jobId: job.id,
            jobType: job.job_type,
            correlationId: job.correlation_id,
            runId: job.run_id,
            projectId: job.project_id,
            stage: job.stage,
            durationMs: Date.now() - executionStartedAt,
            retry: Math.max(0, job.attempts - 1),
            status: "QUEUED",
            event: "job.released"
          });
        } else {
          await completeJob({
            jobId: job.id,
            workerId: this.workerId,
            outputReference: output ?? null
          });
          this.log({
            level: "info",
            service: "worker",
            workerId: this.workerId,
            jobId: job.id,
            jobType: job.job_type,
            correlationId: job.correlation_id,
            runId: job.run_id,
            projectId: job.project_id,
            stage: job.stage,
            durationMs: Date.now() - executionStartedAt,
            retry: Math.max(0, job.attempts - 1),
            status: "SUCCEEDED",
            event: "job.succeeded"
          });
        }
      } catch (error) {
        if (leaseLost) {
          return;
        }
        if (execution.shutdownRequested) {
          await releaseJobLease({ jobId: job.id, workerId: this.workerId });
          return;
        }
        if (cancellationRequested) {
          await acknowledgeJobCancellation({ jobId: job.id, workerId: this.workerId });
          this.log({
            level: "info",
            service: "worker",
            workerId: this.workerId,
            jobId: job.id,
            jobType: job.job_type,
            correlationId: job.correlation_id,
            runId: job.run_id,
            projectId: job.project_id,
            stage: job.stage,
            durationMs: Date.now() - executionStartedAt,
            retry: Math.max(0, job.attempts - 1),
            errorCode: "CANCELLED",
            status: "CANCELLED",
            event: "job.cancelled"
          });
          return;
        }
        const errorClass = timedOut
          ? "RETRYABLE_TIMEOUT"
          : classifyJobExecutionError(error);
        const failed = await failJob({
          jobId: job.id,
          workerId: this.workerId,
          errorClass,
          error: sanitizeJobError(error),
          retryAfterMs:
            error instanceof JobExecutionError ? error.retryAfterMs : undefined
        });
        this.log({
          level: failed.status === "RETRY_WAIT" ? "warn" : "error",
          service: "worker",
          workerId: this.workerId,
          jobId: job.id,
          jobType: job.job_type,
          correlationId: job.correlation_id,
          runId: job.run_id,
          projectId: job.project_id,
          stage: job.stage,
          durationMs: Date.now() - executionStartedAt,
          retry: Math.max(0, job.attempts - 1),
          errorCode: errorClass,
          status: failed.status,
          event: failed.status === "RETRY_WAIT" ? "job.retry_scheduled" : "job.failed"
        });
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
      }
    } catch (error) {
      if (!leaseLost) {
        try {
          const current = await getJob(job.id);
          if (
            current.status === "CANCELLATION_REQUESTED" &&
            current.lease_owner === this.workerId
          ) {
            await acknowledgeJobCancellation({ jobId: job.id, workerId: this.workerId });
            return;
          }
        } catch {
          // A lost or deleted lease is recovered by the database lease policy.
        }
      }
      this.log({
        level: "error",
        service: "worker",
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.job_type,
        correlationId: job.correlation_id,
        runId: job.run_id,
        projectId: job.project_id,
        stage: job.stage,
        durationMs: Date.now() - executionStartedAt,
        retry: Math.max(0, job.attempts - 1),
        errorCode:
          error instanceof JobExecutionError ? error.errorClass : "UNKNOWN",
        event: "job.execution_failed",
        status: "UNRECONCILED"
      });
    }
  }
}
