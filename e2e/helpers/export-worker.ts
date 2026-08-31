import "dotenv/config";

import { closePool } from "@/lib/db";
import { EXPORT_JOB_TYPE } from "@/lib/services/export-jobs";
import { getJob } from "@/lib/services/jobs";
import { DurableWorker } from "@/worker/durable-worker";
import { createExportJobHandler } from "@/worker/export-handler";

async function waitForWorker(worker: DurableWorker): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && worker.activeJobCount > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (worker.activeJobCount !== 0) {
    throw new Error(`Worker ${worker.workerId} did not become idle.`);
  }
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("An export job ID is required.");

  const worker = new DurableWorker(
    new Map([[EXPORT_JOB_TYPE, createExportJobHandler()]]),
    {
      workerId: `e2e-export-${process.pid}`,
      concurrency: 1,
      pollIntervalMs: 10,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 500,
      shutdownGraceMs: 1_000,
      log: () => undefined
    }
  );
  try {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const job = await getJob(jobId);
      if (job.status === "SUCCEEDED") {
        process.stdout.write(`${JSON.stringify({ id: job.id, status: job.status })}\n`);
        return;
      }
      if (["FAILED", "DEAD_LETTER", "CANCELLED"].includes(job.status)) {
        throw new Error(`Export job ${job.id} stopped in ${job.status}.`);
      }
      const claimed = await worker.runOnce();
      await waitForWorker(worker);
      if (claimed === 0) {
        throw new Error(`Export job ${job.id} was not available for processing.`);
      }
    }
    throw new Error(`Export job ${jobId} did not complete within 20 worker cycles.`);
  } finally {
    await worker.stop();
  }
}

try {
  await main();
} finally {
  await closePool();
}
