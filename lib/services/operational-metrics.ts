import { query } from "@/lib/db";

interface MetricsRow {
  queue_depth: string;
  oldest_queued_age_seconds: string | null;
  running_jobs: string;
  retry_jobs: string;
  failed_jobs: string;
  dead_letter_jobs: string;
  active_workers: string;
  stale_workers: string;
  provider_requests: string;
  provider_failures: string;
  provider_latency_ms: string | null;
  provider_retries: string;
  input_tokens: string;
  output_tokens: string;
  estimated_cost: string | null;
  unknown_costs: string;
  estimated_costs: string;
  stage_succeeded: string;
  stage_failed: string;
  stage_blocked: string;
  stage_duration_ms: string | null;
  uploaded_bytes: string;
  scan_duration_ms: string | null;
  infected_rejected_count: string;
  extraction_duration_ms: string | null;
  extraction_failures: string;
  qa_blockers: string;
  export_count: string;
  export_duration_ms: string | null;
}

export interface OperationalMetrics {
  generatedAt: string;
  queue: {
    depth: number;
    oldestQueuedAgeSeconds: number | null;
    running: number;
    retryWaiting: number;
    failed: number;
    deadLetter: number;
  };
  workers: { active: number; stale: number };
  providers: {
    requests: number;
    failures: number;
    failureRate: number;
    averageLatencyMs: number | null;
    retries: number;
    inputTokens: number;
    outputTokens: number;
    costStatus: "KNOWN" | "ESTIMATED" | "UNKNOWN";
    estimatedCostUsd: number | null;
  };
  stages: {
    succeeded: number;
    failed: number;
    blocked: number;
    averageDurationMs: number | null;
  };
  documents: {
    uploadedBytes: number;
    averageScanDurationMs: number | null;
    infectedOrRejected: number;
    averageExtractionDurationMs: number | null;
    extractionFailures: number;
  };
  exports: { count: number; averageDurationMs: number | null };
  qa: { blockers: number };
}

function numeric(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getOperationalMetrics(
  staleWorkerAfterSeconds = 30
): Promise<OperationalMetrics> {
  if (
    !Number.isInteger(staleWorkerAfterSeconds) ||
    staleWorkerAfterSeconds < 5 ||
    staleWorkerAfterSeconds > 3_600
  ) {
    throw new Error("staleWorkerAfterSeconds must be an integer between 5 and 3600");
  }
  const result = await query<MetricsRow>(
    `SELECT
      (SELECT COUNT(*)::text FROM jobs WHERE status = 'QUEUED') AS queue_depth,
      (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at)))::text
       FROM jobs WHERE status = 'QUEUED') AS oldest_queued_age_seconds,
      (SELECT COUNT(*)::text FROM jobs WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLATION_REQUESTED')) AS running_jobs,
      (SELECT COUNT(*)::text FROM jobs WHERE status = 'RETRY_WAIT') AS retry_jobs,
      (SELECT COUNT(*)::text FROM jobs WHERE status = 'FAILED') AS failed_jobs,
      (SELECT COUNT(*)::text FROM jobs WHERE status = 'DEAD_LETTER') AS dead_letter_jobs,
      (SELECT COUNT(*)::text FROM worker_heartbeats
       WHERE status = 'READY' AND last_heartbeat_at > NOW() - ($1 * INTERVAL '1 second')) AS active_workers,
      (SELECT COUNT(*)::text FROM worker_heartbeats
       WHERE status IN ('STARTING', 'READY', 'DRAINING')
         AND last_heartbeat_at <= NOW() - ($1 * INTERVAL '1 second')) AS stale_workers,
      (SELECT COUNT(*)::text FROM provider_executions) AS provider_requests,
      (SELECT COUNT(*)::text FROM provider_executions WHERE status IN ('FAILED', 'TIMED_OUT')) AS provider_failures,
      (SELECT AVG(latency_ms)::text FROM provider_executions WHERE latency_ms IS NOT NULL) AS provider_latency_ms,
      (SELECT COALESCE(SUM(retry_count), 0)::text FROM provider_executions) AS provider_retries,
      (SELECT COALESCE(SUM(input_tokens), 0)::text FROM provider_executions) AS input_tokens,
      (SELECT COALESCE(SUM(output_tokens), 0)::text FROM provider_executions) AS output_tokens,
      (SELECT SUM(estimated_cost)::text FROM provider_executions) AS estimated_cost,
      (SELECT COUNT(*)::text FROM provider_executions WHERE cost_status = 'UNKNOWN') AS unknown_costs,
      (SELECT COUNT(*)::text FROM provider_executions WHERE cost_status = 'ESTIMATED') AS estimated_costs,
      (SELECT COUNT(*)::text FROM research_run_stages WHERE status = 'SUCCEEDED') AS stage_succeeded,
      (SELECT COUNT(*)::text FROM research_run_stages WHERE status = 'FAILED') AS stage_failed,
      (SELECT COUNT(*)::text FROM research_run_stages WHERE status = 'BLOCKED') AS stage_blocked,
      (SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::text
       FROM research_run_stages WHERE completed_at IS NOT NULL AND started_at IS NOT NULL) AS stage_duration_ms,
      (SELECT COALESCE(SUM(byte_size), 0)::text FROM storage_objects WHERE upload_status = 'AVAILABLE') AS uploaded_bytes,
      (SELECT AVG(duration_ms)::text FROM document_scan_results) AS scan_duration_ms,
      (SELECT COUNT(*)::text FROM document_scan_results WHERE result = 'INFECTED') AS infected_rejected_count,
      (SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::text
       FROM document_extractions WHERE completed_at IS NOT NULL) AS extraction_duration_ms,
      (SELECT COUNT(*)::text FROM document_extractions WHERE status = 'FAILED') AS extraction_failures,
      (SELECT COUNT(*)::text FROM qa_findings WHERE is_current = TRUE AND severity = 'BLOCKER' AND resolution_status <> 'RESOLVED') AS qa_blockers,
      (SELECT COUNT(*)::text FROM project_exports WHERE persistence_status = 'AVAILABLE') AS export_count,
      (SELECT AVG(duration_ms)::text FROM project_exports
       WHERE persistence_status = 'AVAILABLE' AND duration_ms IS NOT NULL) AS export_duration_ms`,
    [staleWorkerAfterSeconds]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Operational metrics query returned no row");
  }
  const requests = numeric(row.provider_requests) ?? 0;
  const failures = numeric(row.provider_failures) ?? 0;
  const unknownCosts = numeric(row.unknown_costs) ?? 0;
  const estimatedCosts = numeric(row.estimated_costs) ?? 0;
  return {
    generatedAt: new Date().toISOString(),
    queue: {
      depth: numeric(row.queue_depth) ?? 0,
      oldestQueuedAgeSeconds: numeric(row.oldest_queued_age_seconds),
      running: numeric(row.running_jobs) ?? 0,
      retryWaiting: numeric(row.retry_jobs) ?? 0,
      failed: numeric(row.failed_jobs) ?? 0,
      deadLetter: numeric(row.dead_letter_jobs) ?? 0
    },
    workers: {
      active: numeric(row.active_workers) ?? 0,
      stale: numeric(row.stale_workers) ?? 0
    },
    providers: {
      requests,
      failures,
      failureRate: requests === 0 ? 0 : failures / requests,
      averageLatencyMs: numeric(row.provider_latency_ms),
      retries: numeric(row.provider_retries) ?? 0,
      inputTokens: numeric(row.input_tokens) ?? 0,
      outputTokens: numeric(row.output_tokens) ?? 0,
      costStatus: unknownCosts > 0 ? "UNKNOWN" : estimatedCosts > 0 ? "ESTIMATED" : "KNOWN",
      estimatedCostUsd: unknownCosts > 0 ? null : (numeric(row.estimated_cost) ?? 0)
    },
    stages: {
      succeeded: numeric(row.stage_succeeded) ?? 0,
      failed: numeric(row.stage_failed) ?? 0,
      blocked: numeric(row.stage_blocked) ?? 0,
      averageDurationMs: numeric(row.stage_duration_ms)
    },
    documents: {
      uploadedBytes: numeric(row.uploaded_bytes) ?? 0,
      averageScanDurationMs: numeric(row.scan_duration_ms),
      infectedOrRejected: numeric(row.infected_rejected_count) ?? 0,
      averageExtractionDurationMs: numeric(row.extraction_duration_ms),
      extractionFailures: numeric(row.extraction_failures) ?? 0
    },
    exports: {
      count: numeric(row.export_count) ?? 0,
      averageDurationMs: numeric(row.export_duration_ms)
    },
    qa: { blockers: numeric(row.qa_blockers) ?? 0 }
  };
}
