import os from "node:os";
import { pathToFileURL } from "node:url";
import { getConfig } from "@/lib/config";
import { closePool } from "@/lib/db";
import { structuredLog } from "@/lib/observability/log";
import {
  getWorkerReadiness,
  heartbeatWorker,
  registerWorker,
  stopWorker
} from "@/lib/services/workers";
import { DOCUMENT_JOB_TYPES } from "@/lib/services/document-jobs";
import { DurableWorker } from "@/worker/durable-worker";
import { registerDocumentJobHandlers } from "@/worker/document-handlers";
import { registerExportJobHandler } from "@/worker/export-handler";
import { registeredJobHandlers } from "@/worker/handlers";
import { registerResearchPipelineStageHandler } from "@/worker/research-pipeline-handler";
import { registerSourceSearchHandler } from "@/worker/source-search-handler";

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

export async function main(): Promise<void> {
  registerDocumentJobHandlers();
  registerExportJobHandler();
  registerResearchPipelineStageHandler();
  registerSourceSearchHandler();
  const config = getConfig();
  const workerId = process.env.WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`;
  const worker = new DurableWorker(registeredJobHandlers(), {
    workerId,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.workerPollIntervalMs,
    leaseDurationMs: config.jobLeaseDurationMs,
    heartbeatIntervalMs: config.jobHeartbeatIntervalMs,
    jobTypeConcurrency: {
      [DOCUMENT_JOB_TYPES.extract]: config.documentExtractionConcurrency
    },
    shutdownGraceMs: envInteger("WORKER_SHUTDOWN_GRACE_MS", 30_000)
  });
  await registerWorker({
    workerId,
    serviceVersion: process.env.SERVICE_VERSION?.trim() || "0.2.0",
    concurrency: worker.configuredConcurrency,
    providerConcurrency: config.providerConcurrency,
    extractionConcurrency: worker.configuredJobTypeConcurrency(
      DOCUMENT_JOB_TYPES.extract
    ),
    metadata: { pid: process.pid, hostname: os.hostname() }
  });
  try {
    const ready = await heartbeatWorker({
      workerId,
      status: "READY",
      activeJobs: 0
    });
    if (!ready) {
      throw new Error("The worker registration could not transition to READY.");
    }
  } catch (error) {
    await stopWorker({ workerId, failed: true }).catch(() => false);
    throw error;
  }
  const heartbeat = setInterval(() => {
    void heartbeatWorker({
      workerId,
      status: "READY",
      activeJobs: worker.activeJobCount
    }).catch((error: unknown) => {
      structuredLog("error", "worker.heartbeat_failed", {
        service: "worker",
        workerId,
        errorCode: error instanceof Error ? error.name : "UNKNOWN"
      });
    });
  }, Math.max(1_000, Math.min(10_000, config.jobHeartbeatIntervalMs)));
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (failed = false): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    if (stopping) {
      return Promise.resolve();
    }
    stopping = true;
    stopPromise = (async () => {
      clearInterval(heartbeat);
      if (!failed) {
        await heartbeatWorker({
          workerId,
          status: "DRAINING",
          activeJobs: worker.activeJobCount
        }).catch(() => false);
      }
      await worker.stop();
      await stopWorker({ workerId, failed });
    })();
    return stopPromise;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    await worker.run();
    await stop();
  } catch (error) {
    await stop(true);
    throw error;
  } finally {
    clearInterval(heartbeat);
    await closePool();
  }
}

export async function probeConfiguredWorkerReadiness(
  staleAfterSeconds = 30
): Promise<Awaited<ReturnType<typeof getWorkerReadiness>>> {
  const workerId = process.env.WORKER_ID?.trim();
  if (!workerId) {
    throw new Error("WORKER_ID is required for an external readiness probe.");
  }
  return getWorkerReadiness({ workerId, staleAfterSeconds });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(async (error: unknown) => {
    structuredLog("error", "worker.fatal", {
      service: "worker",
      errorCode: error instanceof Error ? error.name : "UNKNOWN"
    });
    await closePool();
    process.exitCode = 1;
  });
}
