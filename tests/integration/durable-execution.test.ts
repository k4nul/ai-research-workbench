import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool, query } from "@/lib/db";
import { resetTestDatabase } from "@/tests/helpers/database";
import { createProject, approvePlan, approveScope } from "@/lib/services/projects";
import { addResearchPlan, addResearchQuestion } from "@/lib/services/workflow";
import {
  acknowledgeJobCancellation,
  claimJobs,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  JOB_INPUT_MAX_BYTES,
  JOB_OUTPUT_MAX_BYTES,
  manualRetryJob,
  recoverExpiredJobs,
  releaseJobLease,
  requestJobCancellation,
  startJob,
  submitJob
} from "@/lib/services/jobs";
import {
  createResearchRun,
  requestResearchRunCancellation,
  resumeResearchRun
} from "@/lib/services/research-runs";
import { commitRunStage, startRunStage } from "@/lib/services/run-stages";
import { AI_STAGES } from "@/lib/providers";
import { DurableWorker } from "@/worker/durable-worker";
import { syntheticEvaluationProviderConfig } from "@/worker/research-pipeline-handler";

function intake(name: string) {
  return {
    mode: "detailed",
    name,
    clientName: "Durable execution fixture",
    coreQuestion: "Can a durable queue preserve research execution state?",
    background: "Synthetic durable execution fixture.",
    purpose: "Verify queue and run behavior.",
    audience: "Test operator",
    scope: "Durable execution behavior only.",
    exclusions: "Live provider calls.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-30",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "DOCX", "ZIP"],
    specialRequirements: "Synthetic fixtures only."
  };
}

async function createApprovedProject(name: string): Promise<string> {
  const project = await createProject(intake(name));
  await approveScope(project.id);
  const question = await addResearchQuestion(project.id, {
    question: "How does lease recovery preserve at-least-once execution?",
    priority: "HIGH",
    completionCriteria: "A stale job can be reclaimed without duplicate concurrent ownership."
  });
  await addResearchPlan(project.id, {
    questionId: question.id,
    searchStrategy: "Use deterministic synthetic evidence.",
    searchQueries: ["durable queue fixture"],
    primarySourceTypes: ["SYNTHETIC"],
    secondarySourceTypes: [],
    comparisonTargets: ["lease owner"],
    expectedOutput: "A bounded execution trace.",
    completionCondition: "Every transition is persisted.",
    expectedRisks: ["Worker interruption"],
    aiSuggested: false
  });
  await approvePlan(project.id);
  return project.id;
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("durable execution migration", () => {
  it("upgrades one legacy job exactly once and remains rerunnable", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "migrations", "005_durable_execution.sql"),
      "utf8"
    );
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE jobs DROP CONSTRAINT jobs_status_check");
      await client.query(
        "ALTER TABLE jobs ALTER COLUMN idempotency_key DROP NOT NULL, ALTER COLUMN input_reference DROP NOT NULL, ALTER COLUMN input_hash DROP NOT NULL, ALTER COLUMN correlation_id DROP NOT NULL"
      );
      await client.query("ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'PENDING'");
      await client.query(
        "INSERT INTO jobs (id, job_type, payload) VALUES ('legacy-job', 'LEGACY', '{\"value\":1}'::jsonb)"
      );

      await client.query(sql);
      const upgraded = await client.query<{
        status: string;
        idempotency_key: string;
        input_reference: Record<string, unknown>;
        input_hash: string;
        correlation_id: string;
      }>("SELECT status, idempotency_key, input_reference, input_hash, correlation_id FROM jobs WHERE id = 'legacy-job'");
      expect(upgraded.rows[0]).toMatchObject({
        status: "QUEUED",
        idempotency_key: "legacy:legacy-job",
        input_reference: { value: 1 },
        correlation_id: "legacy-job"
      });
      expect(upgraded.rows[0].input_hash).toMatch(/^legacy-md5:/);

      await client.query("UPDATE jobs SET status = 'RUNNING' WHERE id = 'legacy-job'");
      await client.query(sql);
      const rerun = await client.query<{ status: string; column_default: string }>(
        "SELECT j.status, c.column_default FROM jobs j CROSS JOIN information_schema.columns c WHERE j.id = 'legacy-job' AND c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'status'"
      );
      expect(rerun.rows[0].status).toBe("RUNNING");
      expect(rerun.rows[0].column_default).toContain("QUEUED");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("PostgreSQL durable job queue", () => {
  it("deduplicates submissions and rejects idempotency-key input drift", async () => {
    const projectId = await createApprovedProject("Idempotent job submission");
    const first = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { value: 1 },
      idempotencyKey: "same-request"
    });
    const duplicate = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { value: 1 },
      idempotencyKey: "same-request"
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    await expect(
      submitJob({
        projectId,
        jobType: "TEST_JOB",
        inputReference: { value: 2 },
        idempotencyKey: "same-request"
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const count = await query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM jobs WHERE project_id = $1",
      [projectId]
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects oversized UTF-8 input before persisting a job", async () => {
    const projectId = await createApprovedProject("Bounded job input");
    const characterCount = Math.floor(JOB_INPUT_MAX_BYTES / 4);

    await expect(
      submitJob({
        projectId,
        jobType: "TEST_JOB",
        inputReference: { text: "😀".repeat(characterCount) },
        idempotencyKey: "oversized-input"
      })
    ).rejects.toMatchObject({
      status: 413,
      code: "JOB_INPUT_TOO_LARGE",
      details: { maximumBytes: JOB_INPUT_MAX_BYTES }
    });
    const count = await query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM jobs WHERE project_id = $1",
      [projectId]
    );
    expect(count.rows[0].count).toBe(0);
  });

  it("lets only one of two workers claim a job and fences the other worker", async () => {
    const projectId = await createApprovedProject("Two worker claim");
    const submitted = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { operation: "claim-once" },
      idempotencyKey: "claim-once"
    });
    const [left, right] = await Promise.all([
      claimJobs({ workerId: "worker-left", limit: 1, leaseDurationMs: 2_000 }),
      claimJobs({ workerId: "worker-right", limit: 1, leaseDurationMs: 2_000 })
    ]);
    expect(left.length + right.length).toBe(1);
    const owner = left[0]?.lease_owner ?? right[0]?.lease_owner;
    const nonOwner = owner === "worker-left" ? "worker-right" : "worker-left";
    await expect(
      heartbeatJob({
        jobId: submitted.job.id,
        workerId: nonOwner,
        leaseDurationMs: 2_000
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
  });

  it("extends leases with database time and recovers stale work to retry then dead letter", async () => {
    const projectId = await createApprovedProject("Lease recovery");
    const submitted = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { operation: "recover" },
      idempotencyKey: "recover",
      maxAttempts: 2,
      retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    });
    const claimed = (
      await claimJobs({ workerId: "worker-one", limit: 1, leaseDurationMs: 1_000 })
    )[0];
    const started = await startJob(claimed.id, "worker-one", claimed.version);
    const heartbeat = await heartbeatJob({
      jobId: started.id,
      workerId: "worker-one",
      leaseDurationMs: 5_000
    });
    expect(heartbeat.heartbeat_at).toBeInstanceOf(Date);
    expect(heartbeat.lease_expires_at!.getTime()).toBeGreaterThan(
      started.lease_expires_at!.getTime()
    );

    await query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [submitted.job.id]
    );
    const firstRecovery = await recoverExpiredJobs({ random: () => 0.5 });
    expect(firstRecovery).toHaveLength(1);
    expect(firstRecovery[0].status).toBe("RETRY_WAIT");
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [submitted.job.id]);
    const reclaimed = (
      await claimJobs({ workerId: "worker-two", limit: 1, leaseDurationMs: 1_000 })
    )[0];
    await startJob(reclaimed.id, "worker-two", reclaimed.version);
    await query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [submitted.job.id]
    );
    const exhausted = await recoverExpiredJobs({ random: () => 0.5 });
    expect(exhausted[0].status).toBe("DEAD_LETTER");
    const retried = await manualRetryJob(submitted.job.id, "test operator");
    expect(retried).toMatchObject({ status: "QUEUED", attempts: 2, max_attempts: 3 });
    const manualClaim = (
      await claimJobs({ workerId: "worker-three", limit: 1, leaseDurationMs: 1_000 })
    )[0];
    expect(manualClaim).toMatchObject({ id: submitted.job.id, attempts: 3 });
  });

  it("applies retry policy and preserves a single terminal result during cancel/complete races", async () => {
    const projectId = await createApprovedProject("Retry and cancel race");
    const retryJob = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { operation: "retry" },
      idempotencyKey: "retry",
      maxAttempts: 2,
      retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    });
    const retryClaim = (
      await claimJobs({ workerId: "retry-worker", limit: 1, leaseDurationMs: 2_000 })
    )[0];
    await startJob(retryClaim.id, "retry-worker", retryClaim.version);
    const waiting = await failJob({
      jobId: retryJob.job.id,
      workerId: "retry-worker",
      errorClass: "RETRYABLE_NETWORK",
      error: "Bearer secret-token network failure",
      random: () => 0.5
    });
    expect(waiting.status).toBe("RETRY_WAIT");
    expect(waiting.sanitized_error).not.toContain("secret-token");
    await query(
      "UPDATE jobs SET scheduled_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
      [retryJob.job.id]
    );

    const raceJob = await submitJob({
      projectId,
      jobType: "TEST_JOB",
      inputReference: { operation: "race" },
      idempotencyKey: "cancel-race"
    });
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [raceJob.job.id]);
    const raceClaim = (
      await claimJobs({ workerId: "race-worker", limit: 1, leaseDurationMs: 5_000 })
    )[0];
    expect(raceClaim.id).toBe(raceJob.job.id);
    await startJob(raceClaim.id, "race-worker", raceClaim.version);
    await Promise.allSettled([
      requestJobCancellation(raceJob.job.id, "test operator"),
      completeJob({
        jobId: raceJob.job.id,
        workerId: "race-worker",
        outputReference: { completed: true }
      })
    ]);
    let final = await getJob(raceJob.job.id);
    expect(["SUCCEEDED", "CANCELLATION_REQUESTED"]).toContain(final.status);
    if (final.status === "CANCELLATION_REQUESTED") {
      final = await acknowledgeJobCancellation({
        jobId: final.id,
        workerId: "race-worker"
      });
    }
    expect(["SUCCEEDED", "CANCELLED"]).toContain(final.status);
    expect(final.output_hash === null || final.status === "SUCCEEDED").toBe(true);
  });
});

describe("research run snapshots and worker loop", () => {
  it("keeps scoped claim and recovery inside the selected runs", async () => {
    const projectId = await createApprovedProject("Scoped evaluation worker");
    const ordinary = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "ordinary-scoped-run",
      createdBy: "Test operator",
      providerConfigSnapshot: { aiProvider: "openai-responses" }
    });
    const evaluation = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "evaluation-scoped-run",
      createdBy: "Synthetic evaluator test",
      providerConfigSnapshot: syntheticEvaluationProviderConfig(randomUUID())
    });

    const ordinaryClaim = (
      await claimJobs({
        workerId: "ordinary-stale-worker",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"],
        runIds: [ordinary.run.id]
      })
    )[0];
    await query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [ordinaryClaim.id]
    );

    await expect(
      recoverExpiredJobs({
        runIds: [evaluation.run.id],
        random: () => 0.5
      })
    ).resolves.toEqual([]);
    expect(await getJob(ordinaryClaim.id)).toMatchObject({
      status: "CLAIMED",
      lease_owner: "ordinary-stale-worker"
    });

    const evaluationClaim = (
      await claimJobs({
        workerId: "evaluation-worker",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"],
        runIds: [evaluation.run.id]
      })
    )[0];
    expect(evaluationClaim.run_id).toBe(evaluation.run.id);
    expect(await getJob(ordinaryClaim.id)).toMatchObject({ status: "CLAIMED" });

    await releaseJobLease({
      jobId: evaluationClaim.id,
      workerId: "evaluation-worker"
    });
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [
      evaluationClaim.id
    ]);
    const unrestrictedClaim = (
      await claimJobs({
        workerId: "ordinary-unrestricted-worker",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"]
      })
    )[0];
    expect(unrestrictedClaim.run_id).toBe(evaluation.run.id);

    await expect(
      claimJobs({
        workerId: "invalid-filter-worker",
        leaseDurationMs: 5_000,
        runIds: [evaluation.run.id, ` ${evaluation.run.id} `]
      })
    ).rejects.toMatchObject({
      code: "INVALID_JOB_CONFIGURATION",
      message: "runIds must not contain duplicates."
    });
  });

  it("freezes approved revisions and atomically creates all 11 stages once", async () => {
    const projectId = await createApprovedProject("Research run snapshots");
    const first = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "run-request-1",
      createdBy: "Test operator",
      providerConfigSnapshot: { provider: "mock-ai" },
      modelConfigSnapshot: { model: "deterministic-fixture-v1" },
      searchConfigSnapshot: { provider: "mock-search" }
    });
    const duplicate = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "run-request-1",
      createdBy: "Test operator",
      providerConfigSnapshot: { provider: "mock-ai" },
      modelConfigSnapshot: { model: "deterministic-fixture-v1" },
      searchConfigSnapshot: { provider: "mock-search" }
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(first.run.scope_revision_id).toBeTruthy();
    expect(first.run.plan_revision_id).toBeTruthy();
    expect(first.stages.map((stage) => stage.stage_id)).toEqual(AI_STAGES);
    expect(first.stages.filter((stage) => stage.status === "QUEUED")).toHaveLength(1);
    expect(first.stages.filter((stage) => stage.status === "PENDING")).toHaveLength(10);
    expect(first.job).toMatchObject({
      status: "QUEUED",
      job_type: "RESEARCH_PIPELINE_STAGE",
      run_id: first.run.id,
      run_stage_id: first.stages[0].id
    });
    await expect(
      createResearchRun({
        projectId,
        mode: "DRAFT_ONLY",
        idempotencyKey: "run-request-1",
        createdBy: "Test operator"
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("commits a stage domain effect once for the same output key", async () => {
    const projectId = await createApprovedProject("Idempotent stage commit");
    const created = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "stage-commit-run",
      createdBy: "Test operator"
    });
    const claimed = (
      await claimJobs({ workerId: "stage-worker", limit: 1, leaseDurationMs: 5_000 })
    )[0];
    const running = await startJob(claimed.id, "stage-worker", claimed.version);
    const fence = {
      jobId: running.id,
      runStageId: created.stages[0].id,
      attempt: running.attempts,
      workerId: "stage-worker"
    };
    await startRunStage(created.stages[0].id, fence);
    let commitCalls = 0;
    const first = await commitRunStage({
      runStageId: created.stages[0].id,
      fence,
      idempotencyKey: "stage-output-1",
      outputReference: { refinedQuestion: "Synthetic durable execution question" },
      domainCommit: async (client) => {
        commitCalls += 1;
        await client.query("SELECT 1");
      }
    });
    const duplicate = await commitRunStage({
      runStageId: created.stages[0].id,
      fence,
      idempotencyKey: "stage-output-1",
      outputReference: { refinedQuestion: "Synthetic durable execution question" },
      domainCommit: async () => {
        commitCalls += 1;
      }
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(commitCalls).toBe(1);
    expect(first.stage).toMatchObject({ status: "SUCCEEDED" });
    await expect(
      commitRunStage({
        runStageId: created.stages[0].id,
        fence,
        idempotencyKey: "stage-output-1",
        outputReference: { refinedQuestion: "Different output" },
        domainCommit: async () => undefined
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await completeJob({
      jobId: claimed.id,
      workerId: "stage-worker",
      outputReference: { committed: true }
    });
  });

  it("rejects output from expired attempt A after attempt B reclaims the stage", async () => {
    const projectId = await createApprovedProject("Stage lease fence");
    const created = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "stage-lease-fence",
      createdBy: "Test operator"
    });
    const stage = created.stages[0];
    const claimedA = (
      await claimJobs({
        workerId: "worker-a",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"]
      })
    )[0];
    const runningA = await startJob(claimedA.id, "worker-a", claimedA.version);
    const fenceA = {
      jobId: runningA.id,
      runStageId: stage.id,
      attempt: runningA.attempts,
      workerId: "worker-a"
    };
    await startRunStage(stage.id, fenceA);
    await query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [runningA.id]
    );
    await recoverExpiredJobs({ random: () => 0.5 });
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [runningA.id]);
    const claimedB = (
      await claimJobs({
        workerId: "worker-b",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"]
      })
    )[0];
    const runningB = await startJob(claimedB.id, "worker-b", claimedB.version);
    const fenceB = {
      jobId: runningB.id,
      runStageId: stage.id,
      attempt: runningB.attempts,
      workerId: "worker-b"
    };
    await startRunStage(stage.id, fenceB);

    await expect(
      commitRunStage({
        runStageId: stage.id,
        fence: fenceA,
        idempotencyKey: "late-output-a",
        outputReference: { refinedQuestion: "Late output from A" },
        domainCommit: async () => undefined
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });

    const committed = await commitRunStage({
      runStageId: stage.id,
      fence: fenceB,
      idempotencyKey: "current-output-b",
      outputReference: { refinedQuestion: "Current output from B" },
      domainCommit: async () => undefined
    });
    expect(committed.stage.status).toBe("SUCCEEDED");
    await completeJob({
      jobId: runningB.id,
      workerId: "worker-b",
      outputReference: { committed: true }
    });
  });

  it("atomically fails a run stage when its final worker lease dies", async () => {
    const projectId = await createApprovedProject("Dead-letter reconciliation");
    const created = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "dead-letter-reconciliation",
      createdBy: "Test operator"
    });
    const claimed = (
      await claimJobs({
        workerId: "crashed-worker",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"]
      })
    )[0];
    const running = await startJob(claimed.id, "crashed-worker", claimed.version);
    await startRunStage(created.stages[0].id, {
      jobId: running.id,
      runStageId: created.stages[0].id,
      attempt: running.attempts,
      workerId: "crashed-worker"
    });
    await query(
      "UPDATE jobs SET max_attempts = attempts, lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [running.id]
    );
    const recovered = await recoverExpiredJobs({ random: () => 0.5 });
    expect(recovered[0].status).toBe("DEAD_LETTER");
    const state = await query<{
      job_status: string;
      stage_status: string;
      run_status: string;
    }>(
      `SELECT j.status AS job_status, rrs.status AS stage_status,
              rr.status AS run_status
       FROM jobs j
       JOIN research_run_stages rrs ON rrs.id = j.run_stage_id
       JOIN research_runs rr ON rr.id = j.run_id
       WHERE j.id = $1`,
      [running.id]
    );
    expect(state.rows[0]).toEqual({
      job_status: "DEAD_LETTER",
      stage_status: "FAILED",
      run_status: "FAILED"
    });
    await expect(manualRetryJob(running.id, "Test operator")).rejects.toMatchObject({
      code: "PIPELINE_STAGE_RESTART_REQUIRED"
    });
  });

  it("finalizes run cancellation when the worker acknowledges it", async () => {
    const projectId = await createApprovedProject("Cancellation acknowledgement");
    const created = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "cancellation-acknowledgement",
      createdBy: "Test operator"
    });
    const claimed = (
      await claimJobs({
        workerId: "cancel-worker",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: ["RESEARCH_PIPELINE_STAGE"]
      })
    )[0];
    const running = await startJob(claimed.id, "cancel-worker", claimed.version);
    await startRunStage(created.stages[0].id, {
      jobId: running.id,
      runStageId: created.stages[0].id,
      attempt: running.attempts,
      workerId: "cancel-worker"
    });
    const cancelling = await requestResearchRunCancellation(
      created.run.id,
      "Test operator"
    );
    expect(cancelling.status).toBe("CANCELLING");
    await acknowledgeJobCancellation({
      jobId: running.id,
      workerId: "cancel-worker"
    });
    const state = await query<{ run_status: string; stage_status: string }>(
      `SELECT rr.status AS run_status, rrs.status AS stage_status
       FROM research_runs rr
       JOIN research_run_stages rrs ON rrs.id = $2
       WHERE rr.id = $1`,
      [created.run.id, created.stages[0].id]
    );
    expect(state.rows[0]).toEqual({
      run_status: "CANCELLED",
      stage_status: "CANCELLED"
    });
  });

  it("resumes the earliest incomplete latest generation", async () => {
    const projectId = await createApprovedProject("Latest generation resume");
    const created = await createResearchRun({
      projectId,
      mode: "ORCHESTRATED",
      idempotencyKey: "latest-generation-resume",
      createdBy: "Test operator"
    });
    const first = created.stages[0];
    const second = created.stages[1];
    await query("UPDATE jobs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1", [
      created.job!.id
    ]);
    await query(
      "UPDATE research_run_stages SET status = CASE WHEN id = $2 THEN 'STALE' ELSE 'CANCELLED' END, completed_at = NOW() WHERE run_id = $1",
      [created.run.id, first.id]
    );
    await query(
      `INSERT INTO research_run_stages (
         id, run_id, stage_id, ordinal, generation, status, pipeline_version,
         prompt_template_version, structured_schema_version, input_reference,
         input_hash, output_reference, output_hash, completed_at
       )
       SELECT 'latest-generation-stage', run_id, stage_id, ordinal, 2,
              'SUCCEEDED', pipeline_version, prompt_template_version,
              structured_schema_version, input_reference, input_hash,
              '{}'::jsonb, 'latest-generation-output', NOW()
       FROM research_run_stages WHERE id = $1`,
      [first.id]
    );
    await query(
      "UPDATE research_runs SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1",
      [created.run.id]
    );

    const resumed = await resumeResearchRun(created.run.id, "Test operator");
    expect(resumed.stage).toMatchObject({
      id: second.id,
      stage_id: "question_decomposition",
      generation: 1,
      status: "QUEUED"
    });
    expect(resumed.job.run_stage_id).toBe(second.id);
  });

  it("keeps an ignored timeout result from becoming a late success", async () => {
    const submitted = await submitJob({
      jobType: "IGNORES_TIMEOUT",
      inputReference: { operation: "late-return" },
      idempotencyKey: "ignored-timeout",
      maxAttempts: 1,
      timeoutMs: 10
    });
    let markReturned!: () => void;
    const handlerReturned = new Promise<void>((resolve) => {
      markReturned = resolve;
    });
    const worker = new DurableWorker(
      new Map([
        [
          "IGNORES_TIMEOUT",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            markReturned();
            return { late: true };
          }
        ]
      ]),
      {
        workerId: "timeout-worker",
        concurrency: 1,
        pollIntervalMs: 10,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        shutdownGraceMs: 1_000,
        log: () => undefined
      }
    );
    expect(await worker.runOnce()).toBe(1);
    await handlerReturned;
    for (let attempt = 0; attempt < 50 && worker.activeJobCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const current = await getJob(submitted.job.id);
    await worker.stop();
    expect(current).toMatchObject({
      status: "DEAD_LETTER",
      error_class: "RETRYABLE_TIMEOUT",
      output_reference: null,
      output_hash: null
    });
  });

  it("fails oversized worker output without retrying or logging its content", async () => {
    const submitted = await submitJob({
      jobType: "OVERSIZED_OUTPUT",
      inputReference: { operation: "bounded-output" },
      idempotencyKey: "oversized-output",
      correlationId: "correlation-oversized-output"
    });
    const logs: Record<string, unknown>[] = [];
    const characterCount = Math.floor(JOB_OUTPUT_MAX_BYTES / 4);
    const worker = new DurableWorker(
      new Map([
        [
          "OVERSIZED_OUTPUT",
          async () => ({ text: "😀".repeat(characterCount) })
        ]
      ]),
      {
        workerId: "bounded-output-worker",
        concurrency: 1,
        pollIntervalMs: 10,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        shutdownGraceMs: 1_000,
        log: (entry) => logs.push(entry)
      }
    );

    expect(await worker.runOnce()).toBe(1);
    let current = await getJob(submitted.job.id);
    for (
      let attempt = 0;
      attempt < 50 && !["FAILED", "DEAD_LETTER", "SUCCEEDED"].includes(current.status);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await getJob(submitted.job.id);
    }
    await worker.stop();

    expect(current).toMatchObject({
      status: "FAILED",
      attempts: 1,
      error_class: "NON_RETRYABLE_VALIDATION",
      output_reference: null,
      output_hash: null
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "job.failed",
        jobId: submitted.job.id,
        jobType: "OVERSIZED_OUTPUT",
        correlationId: "correlation-oversized-output",
        errorCode: "NON_RETRYABLE_VALIDATION"
      })
    );
    expect(JSON.stringify(logs)).not.toContain("😀");
  });

  it("enforces a per-type extraction cap while using other worker capacity", async () => {
    const first = await submitJob({
      jobType: "DOCUMENT_EXTRACT",
      inputReference: { fixture: "first" },
      idempotencyKey: "extraction-cap-first",
      priority: 20
    });
    const second = await submitJob({
      jobType: "DOCUMENT_EXTRACT",
      inputReference: { fixture: "second" },
      idempotencyKey: "extraction-cap-second",
      priority: 10
    });
    const other = await submitJob({
      jobType: "NOOP",
      inputReference: { fixture: "other-capacity" },
      idempotencyKey: "extraction-cap-other"
    });
    let releaseExtraction!: () => void;
    const extractionReleased = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let markExtractionStarted!: () => void;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    let extractionStarts = 0;
    const worker = new DurableWorker(
      new Map([
        [
          "DOCUMENT_EXTRACT",
          async () => {
            extractionStarts += 1;
            markExtractionStarted();
            await extractionReleased;
            return { handled: true };
          }
        ],
        ["NOOP", async () => ({ handled: true })]
      ]),
      {
        workerId: "extraction-cap-worker",
        concurrency: 3,
        jobTypeConcurrency: { DOCUMENT_EXTRACT: 1 },
        pollIntervalMs: 10,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        shutdownGraceMs: 1_000,
        log: () => undefined
      }
    );

    expect(await worker.runOnce()).toBe(2);
    await extractionStarted;
    expect(extractionStarts).toBe(1);
    await expect(getJob(second.job.id)).resolves.toMatchObject({ status: "QUEUED" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await getJob(other.job.id)).status === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(getJob(other.job.id)).resolves.toMatchObject({ status: "SUCCEEDED" });

    releaseExtraction();
    for (let attempt = 0; attempt < 50 && worker.activeJobCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(getJob(first.job.id)).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(await worker.runOnce()).toBe(1);
    for (let attempt = 0; attempt < 50 && worker.activeJobCount > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(getJob(second.job.id)).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(extractionStarts).toBe(2);
    await worker.stop();
  });

  it("executes a registered handler outside the caller and persists its result", async () => {
    const submitted = await submitJob({
      jobType: "NOOP",
      inputReference: { operation: "worker-loop" },
      idempotencyKey: "worker-loop"
    });
    const worker = new DurableWorker(
      new Map([
        [
          "NOOP",
          async ({ signal }) => {
            expect(signal.aborted).toBe(false);
            return { handled: true };
          }
        ]
      ]),
      {
        workerId: "integration-worker",
        concurrency: 1,
        pollIntervalMs: 10,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        shutdownGraceMs: 1_000,
        log: () => undefined
      }
    );
    expect(await worker.runOnce()).toBe(1);
    let current = await getJob(submitted.job.id);
    for (let attempt = 0; attempt < 50 && current.status !== "SUCCEEDED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await getJob(submitted.job.id);
    }
    await worker.stop();
    expect(current.status).toBe("SUCCEEDED");
    expect(current.output_reference).toEqual({ handled: true });
    expect(current.output_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
