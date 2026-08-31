import "dotenv/config";

import { getConfig } from "../lib/config.js";
import { closePool, query } from "../lib/db.js";
import { getDocumentRuntime } from "../lib/documents/runtime.js";
import { selectProviders } from "../lib/providers/index.js";
import { probeConfiguredWorkerReadiness } from "../worker/main.js";

type ReadinessChecks = {
  database: boolean;
  queue: boolean;
  heartbeat: boolean;
  workerStatus: boolean;
  objectStorage: boolean;
  malwareScanner: boolean;
  providerConfiguration: boolean;
};

async function main(): Promise<void> {
  const config = getConfig();
  const runtime = getDocumentRuntime();
  const providers = selectProviders({
    demoMode: config.demoMode,
    openAiApiKey: config.openAiApiKey,
    openAiModel: config.openAiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    timeoutMs: config.fetchTimeoutMs
  });
  const [worker, queue, storage, scan] = await Promise.all([
    probeConfiguredWorkerReadiness(30),
    query<{ jobs: string }>("SELECT to_regclass('public.jobs')::text AS jobs"),
    runtime.storage.list("debug/readiness"),
    runtime.scanner.scan({
      bytes: new TextEncoder().encode("AI Research Workbench worker readiness fixture.")
    })
  ]);
  void storage;
  const checks: ReadinessChecks = {
    database: worker.checks.database,
    queue: queue.rows[0]?.jobs === "jobs",
    heartbeat: worker.checks.heartbeat,
    workerStatus: worker.checks.status,
    objectStorage: true,
    malwareScanner: scan.status === "CLEAN",
    providerConfiguration:
      providers.ai.isConfigured() && providers.search.isConfigured()
  };
  const ready = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      status: ready ? "ready" : "not-ready",
      workerId: process.env.WORKER_ID,
      checks,
      scanner: {
        provider: scan.scanner,
        version: scan.scannerVersion ?? null,
        signatureDatabaseVersion: scan.signatureDatabaseVersion ?? null
      }
    }) + "\n"
  );
  if (!ready) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        status: "not-ready",
        workerId: process.env.WORKER_ID,
        error: error instanceof Error ? error.message : "Readiness check failed."
      }) + "\n"
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
