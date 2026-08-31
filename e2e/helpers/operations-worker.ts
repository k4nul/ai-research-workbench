import "dotenv/config";

import { closePool, query } from "@/lib/db";
import { MockAIProvider } from "@/lib/providers";
import { claimJobs, startJob } from "@/lib/services/jobs";
import { getResearchRun } from "@/lib/services/research-runs";
import { DurableWorker } from "@/worker/durable-worker";
import {
  createResearchPipelineStageHandler,
  RESEARCH_PIPELINE_STAGE_JOB
} from "@/worker/research-pipeline-handler";

function pipelineHandler() {
  return createResearchPipelineStageHandler({
    providerForRun: () => new MockAIProvider(),
    permitPolicy: {
      requestLimit: 1_000_000,
      windowSeconds: 3_600,
      concurrencyLimit: 10,
      permitTtlMs: 5_000
    }
  });
}

function researchWorker(runId: string, suffix: string): DurableWorker {
  return new DurableWorker(
    new Map([[RESEARCH_PIPELINE_STAGE_JOB, pipelineHandler()]]),
    {
      workerId: `e2e-${suffix}-${runId}`,
      concurrency: 1,
      pollIntervalMs: 10,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 250,
      shutdownGraceMs: 1_000,
      runIds: [runId],
      log: () => undefined
    }
  );
}

async function waitForWorker(worker: DurableWorker): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && worker.activeJobCount > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (worker.activeJobCount !== 0) {
    throw new Error(`Worker ${worker.workerId} did not become idle.`);
  }
}

async function executeWorkerCycle(worker: DurableWorker, runId: string): Promise<number> {
  await query(
    "UPDATE jobs SET scheduled_at = NOW() WHERE run_id = $1 AND status = 'RETRY_WAIT'",
    [runId]
  );
  const claimed = await worker.runOnce();
  await waitForWorker(worker);
  return claimed;
}

async function readyJobCount(runId: string): Promise<number> {
  const result = await query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM jobs WHERE run_id = $1 AND status IN ('QUEUED', 'RETRY_WAIT', 'CLAIMED', 'RUNNING')",
    [runId]
  );
  return result.rows[0]?.count ?? 0;
}

async function executeOne(runId: string): Promise<unknown> {
  const worker = researchWorker(runId, "browser-cycle");
  try {
    const claimed = await executeWorkerCycle(worker, runId);
    const detail = await getResearchRun(runId);
    return {
      claimed,
      status: detail.run.status,
      progress: detail.run.progress,
      readyJobs: await readyJobCount(runId)
    };
  } finally {
    await worker.stop();
  }
}

async function executeLeaseRecovery(runId: string): Promise<unknown> {
  const preparationWorker = researchWorker(runId, "pre-lease-loss");
  try {
    for (let completed = 0; completed < 4; completed += 1) {
      const claimed = await executeWorkerCycle(preparationWorker, runId);
      if (claimed !== 1) {
        throw new Error(`Expected one preparation job, received ${claimed}.`);
      }
    }
  } finally {
    await preparationWorker.stop();
  }

  const beforeLoss = await getResearchRun(runId);
  const evidenceStage = beforeLoss.stages.find(
    (stage) => stage.stage_id === "evidence_extraction"
  );
  const evidenceJob = beforeLoss.jobs.find(
    (job) => job.run_stage_id === evidenceStage?.id && job.status === "QUEUED"
  );
  if (!evidenceStage || !evidenceJob) {
    throw new Error("The evidence stage was not queued for the lease-loss fixture.");
  }

  await query("UPDATE jobs SET priority = 1000 WHERE id = $1", [evidenceJob.id]);
  const lostWorkerId = `e2e-lost-worker-${runId}`;
  const claimed = (
    await claimJobs({
      workerId: lostWorkerId,
      limit: 1,
      leaseDurationMs: 5_000,
      jobTypes: [RESEARCH_PIPELINE_STAGE_JOB],
      runIds: [runId]
    })
  )[0];
  if (!claimed || claimed.id !== evidenceJob.id) {
    throw new Error("The lease-loss worker did not claim the evidence job.");
  }
  const started = await startJob(claimed.id, lostWorkerId, claimed.version);
  await pipelineHandler()({
    job: started,
    workerId: lostWorkerId,
    signal: new AbortController().signal
  });
  await query(
    "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1 AND status = 'RUNNING'",
    [evidenceJob.id]
  );

  const recoveryWorker = researchWorker(runId, "lease-recovery");
  try {
    const recoveryClaimed = await executeWorkerCycle(recoveryWorker, runId);
    if (recoveryClaimed !== 1) {
      throw new Error(`Expected one job after lease recovery, received ${recoveryClaimed}.`);
    }
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [evidenceJob.id]);
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const detail = await getResearchRun(runId);
      if (detail.run.status === "APPROVAL_REQUIRED" && (await readyJobCount(runId)) === 0) {
        break;
      }
      await executeWorkerCycle(recoveryWorker, runId);
    }
  } finally {
    await recoveryWorker.stop();
  }

  const recovered = await getResearchRun(runId);
  const recoveredEvidenceJob = recovered.jobs.find((job) => job.id === evidenceJob.id);
  const effects = await query<{
    evidence_count: number;
    commit_count: number;
    execution_count: number;
    lease_expiry_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::integer FROM evidence WHERE id LIKE $1) AS evidence_count,
       (SELECT COUNT(*)::integer FROM stage_domain_commits WHERE run_stage_id = $2) AS commit_count,
       (SELECT COUNT(*)::integer FROM provider_executions WHERE run_stage_id = $2) AS execution_count,
       (SELECT COUNT(*)::integer FROM job_events WHERE job_id = $3 AND event_type = 'JOB_LEASE_EXPIRED') AS lease_expiry_count`,
    [`ai-evidence-${evidenceStage.id}-%`, evidenceStage.id, evidenceJob.id]
  );
  const runExecutions = await query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM provider_executions WHERE run_id = $1",
    [runId]
  );
  return {
    status: recovered.run.status,
    providerRequests: recovered.run.total_provider_requests,
    readyJobs: await readyJobCount(runId),
    evidenceJob: recoveredEvidenceJob
      ? { id: recoveredEvidenceJob.id, status: recoveredEvidenceJob.status, attempts: recoveredEvidenceJob.attempts }
      : null,
    effects: effects.rows[0],
    runExecutionCount: runExecutions.rows[0]?.count ?? 0
  };
}

async function main(): Promise<void> {
  const [command, runId] = process.argv.slice(2);
  if (!runId) throw new Error("A research run ID is required.");
  switch (command) {
    case "cycle":
      process.stdout.write(`${JSON.stringify(await executeOne(runId))}\n`);
      return;
    case "lease-recovery":
      process.stdout.write(`${JSON.stringify(await executeLeaseRecovery(runId))}\n`);
      return;
    default:
      throw new Error(`Unknown operations worker command: ${String(command)}`);
  }
}

try {
  await main();
} finally {
  await closePool();
}
