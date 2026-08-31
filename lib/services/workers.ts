import { query } from "@/lib/db";

export type WorkerStatus = "STARTING" | "READY" | "DRAINING" | "STOPPED" | "FAILED";

export interface WorkerRegistration {
  workerId: string;
  serviceVersion: string;
  concurrency: number;
  providerConcurrency: number;
  extractionConcurrency: number;
  metadata?: Readonly<Record<string, unknown>>;
}

function positiveInteger(value: number, name: string, maximum = 1_000): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
}

export async function registerWorker(input: WorkerRegistration): Promise<void> {
  positiveInteger(input.concurrency, "concurrency");
  positiveInteger(input.providerConcurrency, "providerConcurrency");
  positiveInteger(input.extractionConcurrency, "extractionConcurrency");
  await query(
    `INSERT INTO worker_heartbeats (
       worker_id, service_version, status, concurrency,
       provider_concurrency, extraction_concurrency, metadata
     ) VALUES ($1, $2, 'STARTING', $3, $4, $5, $6::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET
       service_version = EXCLUDED.service_version,
       status = 'STARTING', concurrency = EXCLUDED.concurrency,
       active_jobs = 0,
       provider_concurrency = EXCLUDED.provider_concurrency,
       extraction_concurrency = EXCLUDED.extraction_concurrency,
       started_at = NOW(), stopped_at = NULL, last_heartbeat_at = NOW(),
       metadata = EXCLUDED.metadata, updated_at = NOW()`,
    [
      input.workerId,
      input.serviceVersion,
      input.concurrency,
      input.providerConcurrency,
      input.extractionConcurrency,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function heartbeatWorker(input: {
  workerId: string;
  status: Extract<WorkerStatus, "STARTING" | "READY" | "DRAINING">;
  activeJobs: number;
}): Promise<boolean> {
  if (!Number.isInteger(input.activeJobs) || input.activeJobs < 0) {
    throw new Error("activeJobs must be a non-negative integer");
  }
  const result = await query(
    `UPDATE worker_heartbeats
     SET status = $2, active_jobs = $3, last_heartbeat_at = NOW(), updated_at = NOW()
     WHERE worker_id = $1 AND status NOT IN ('STOPPED', 'FAILED')
       AND $3 <= concurrency`,
    [input.workerId, input.status, input.activeJobs]
  );
  return result.rowCount === 1;
}

export async function stopWorker(input: {
  workerId: string;
  failed?: boolean;
}): Promise<boolean> {
  const result = await query(
    `UPDATE worker_heartbeats
     SET status = $2, active_jobs = 0, stopped_at = NOW(),
         last_heartbeat_at = NOW(), updated_at = NOW()
     WHERE worker_id = $1`,
    [input.workerId, input.failed ? "FAILED" : "STOPPED"]
  );
  return result.rowCount === 1;
}

export async function listWorkers(staleAfterSeconds = 30): Promise<Record<string, unknown>[]> {
  positiveInteger(staleAfterSeconds, "staleAfterSeconds", 3_600);
  const result = await query<Record<string, unknown>>(
    `SELECT worker_id, service_version, status, concurrency, active_jobs,
            provider_concurrency, extraction_concurrency, started_at,
            last_heartbeat_at, stopped_at, metadata,
            CASE WHEN status IN ('STARTING', 'READY', 'DRAINING')
              AND last_heartbeat_at <= NOW() - ($1 * INTERVAL '1 second')
              THEN TRUE ELSE FALSE END AS stale
     FROM worker_heartbeats
     ORDER BY last_heartbeat_at DESC`,
    [staleAfterSeconds]
  );
  return result.rows;
}

export async function getWorkerReadiness(input: {
  workerId: string;
  staleAfterSeconds: number;
}): Promise<{
  ready: boolean;
  checks: { database: boolean; heartbeat: boolean; status: boolean };
}> {
  positiveInteger(input.staleAfterSeconds, "staleAfterSeconds", 3_600);
  const result = await query<{ status: WorkerStatus; heartbeat: boolean }>(
    `SELECT status,
            last_heartbeat_at > NOW() - ($2 * INTERVAL '1 second') AS heartbeat
     FROM worker_heartbeats WHERE worker_id = $1`,
    [input.workerId, input.staleAfterSeconds]
  );
  const worker = result.rows[0];
  const checks = {
    database: true,
    heartbeat: worker?.heartbeat ?? false,
    status: worker?.status === "READY"
  };
  return { ready: Object.values(checks).every(Boolean), checks };
}
