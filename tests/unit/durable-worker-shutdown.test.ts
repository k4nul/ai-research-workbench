import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/services/jobs";

const jobs = vi.hoisted(() => ({
  claimJobs: vi.fn(),
  recoverExpiredJobs: vi.fn(),
  releaseJobLease: vi.fn(),
  startJob: vi.fn()
}));

vi.mock("@/lib/services/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/jobs")>()),
  ...jobs
}));

import { DurableWorker } from "@/worker/durable-worker";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function claimedJob(): JobRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "delayed-claim-job",
    project_id: null,
    run_id: null,
    run_stage_id: null,
    stage: null,
    job_type: "NOOP",
    payload: {},
    status: "CLAIMED",
    priority: 0,
    idempotency_key: "delayed-claim-job",
    input_reference: {},
    input_hash: "input-hash",
    output_reference: null,
    output_hash: null,
    attempts: 1,
    max_attempts: 3,
    scheduled_at: now,
    claimed_at: now,
    started_at: null,
    completed_at: null,
    lease_owner: "shutdown-worker",
    lease_expires_at: now,
    heartbeat_at: now,
    timeout_ms: 1_000,
    retry_policy: {},
    error_class: null,
    sanitized_error: null,
    cancellation_requested_at: null,
    parent_job_id: null,
    correlation_id: "delayed-claim-correlation",
    created_at: now,
    updated_at: now,
    version: "1"
  };
}

describe("durable worker shutdown", () => {
  beforeEach(() => {
    jobs.claimJobs.mockReset();
    jobs.recoverExpiredJobs.mockReset();
    jobs.releaseJobLease.mockReset();
    jobs.startJob.mockReset();
  });

  it("waits for a delayed claim and releases it without starting its handler", async () => {
    const job = claimedJob();
    const delayedClaim = deferred<JobRow[]>();
    const handler = vi.fn(async () => ({ handled: true }));
    jobs.recoverExpiredJobs.mockResolvedValue([]);
    jobs.claimJobs.mockReturnValue(delayedClaim.promise);
    jobs.releaseJobLease.mockResolvedValue({ ...job, status: "RETRY_WAIT" });
    const worker = new DurableWorker(new Map([["NOOP", handler]]), {
      workerId: "shutdown-worker",
      concurrency: 1,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      shutdownGraceMs: 0,
      runIds: [" evaluation-run "],
      log: () => undefined
    });

    const poll = worker.runOnce();
    await vi.waitFor(() => expect(jobs.claimJobs).toHaveBeenCalledOnce());

    const stop = worker.stop();
    await expect(
      Promise.race([
        stop.then(() => "stopped"),
        Promise.resolve("poll-pending")
      ])
    ).resolves.toBe("poll-pending");

    delayedClaim.resolve([job]);
    await expect(poll).resolves.toBe(0);
    await stop;

    expect(jobs.recoverExpiredJobs).toHaveBeenCalledWith({
      limit: 100,
      runIds: ["evaluation-run"]
    });
    expect(jobs.claimJobs).toHaveBeenCalledWith({
      workerId: "shutdown-worker",
      limit: 1,
      leaseDurationMs: 1_000,
      jobTypes: ["NOOP"],
      runIds: ["evaluation-run"]
    });

    expect(jobs.releaseJobLease).toHaveBeenCalledWith({
      jobId: job.id,
      workerId: "shutdown-worker"
    });
    expect(jobs.startJob).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
