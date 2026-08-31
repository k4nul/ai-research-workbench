# Operations

## Runtime topology

AI Research Workbench has separate web and worker processes sharing PostgreSQL and private object storage. The web process authenticates operators, validates requests, records workflow mutations, and submits jobs. The worker claims and executes registered job types. PostgreSQL is the authoritative queue, lease, run, stage, provider-execution, and audit store.

`npm run dev:all` starts the development web process and one worker. The supported Compose topology adds PostgreSQL 17, a private MinIO bucket, ClamAV, a one-shot migration service, web, and worker. The registered worker handlers are:

The worker enforces `WORKER_CONCURRENCY` globally and `DOCUMENT_EXTRACTION_CONCURRENCY` as a per-worker cap for `DOCUMENT_EXTRACT`; the advertised extraction capacity is normalized to the global cap.

| Job type | Handler | Durable effect |
| --- | --- | --- |
| `RESEARCH_PIPELINE_STAGE` | `worker/research-pipeline-handler.ts` | Executes one versioned run-stage generation, records provider provenance, commits domain effects, and advances the run. |
| `DOCUMENT_SCAN` | `worker/document-handlers.ts` | Reads the quarantined object, records a malware result, and optionally submits extraction. |
| `DOCUMENT_EXTRACT` | `worker/document-handlers.ts` | Extracts bounded text, chunks, and anchors after a clean scan. |
| `STORAGE_CLEANUP` | `worker/document-handlers.ts` | Reconciles cataloged and untracked private objects according to explicit cleanup input. |
| `SOURCE_SEARCH` | `worker/source-search-handler.ts` | Reserves a provider execution, applies provider limits, records provenance, and commits bounded search results. |
| `GENERATE_EXPORT` | `worker/export-handler.ts` | Generates, verifies, and persists one frozen deliverable under the claimed job lease. |

## Delivery and idempotency contract

Every HTTP `POST`, `PUT`, `PATCH`, or `DELETE` requires a validated `Idempotency-Key`. Authenticated JSON mutations use a central PostgreSQL receipt scoped by principal, method, pathname, and key. Its request hash includes the raw query string, content type, and bounded request bytes, so body or query drift returns `409 IDEMPOTENCY_KEY_REUSED`. The receipt, database domain writes, and audit writes share one transaction; concurrent duplicates serialize and a response-loss retry returns the exact stored JSON/status. Stored receipt JSON is validated and limited to 4 MiB. Invalid JSON/validation never leaves a receipt or partial database effect.

The two multipart upload routes are the explicit dedicated exception to central body buffering: `/api/projects/:projectId/documents` and `/api/projects/:projectId/sources/upload`. Their bounded parser computes the file hash before durable document/object/job idempotency checks. Auth login/logout/password/session routes also use the same receipt table through a cookie-aware wrapper; this permits exact cookie replay without storing credentials or raw tokens. All JSON job, run, scan/extract, search, export-submission, and research-graph mutations use the central wrapper even when their service also has a domain key.

The queue is **at least once, not exactly once**. A worker can lose its lease after an external effect succeeds but before the database acknowledges completion; the same logical work may then run again. The repository uses several complementary controls:

- job submission is unique by project plus idempotency key;
- the canonical JSON input is hashed, and reuse with different type, input, run, or stage returns `IDEMPOTENCY_KEY_REUSED`;
- job output is hashed when completion is acknowledged;
- research stages use immutable pipeline, prompt, and schema versions plus a generation number;
- research-stage, export, and document handlers lock the authoritative job immediately before each domain commit and require the claimed job ID, exact attempt and worker, `RUNNING` status, and an unexpired database-time lease; the claimed job version is a lower bound because a valid heartbeat advances it, and a stale attempt cannot commit;
- `stage_domain_commits` records the stage generation, idempotency key, and output hash with the domain transaction;
- a completed stage can be replayed to advance orchestration without repeating its domain commit;
- document jobs freeze the expected object SHA-256 and extraction identity;
- operator retry/cancel/resume actions require a request idempotency key and are recorded in job events or audit state.

These controls do not make arbitrary side effects exactly once. Any new handler that sends mail, calls a provider, writes another system, or otherwise acts outside the commit transaction needs its own stable request key, replay lookup, reconciliation strategy, and test for the “effect succeeded, acknowledgement failed” case.

Document workers apply that fence before entering `SCANNING` or `EXTRACTING`, before committing scan, extraction, extraction-failure, source, catalog, or audit effects, and when a scan submits its extraction child. Failed attempts do not eagerly delete deterministic clean-source or extraction objects because a reclaimed attempt may already be reusing uncataloged bytes; an unreferenced leftover remains subject to the grace-period orphan cleanup process.

## Job lifecycle

The durable statuses are:

```text
QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED
   |         |          |
   |         |          +-> RETRY_WAIT -> CLAIMED
   |         |          +-> FAILED
   |         |          +-> DEAD_LETTER
   |         |          +-> CANCELLATION_REQUESTED -> CANCELLED
   |         +-> the same failure/cancellation outcomes
   +-> CANCELLED
```

Workers claim ready `QUEUED` or `RETRY_WAIT` rows in priority and schedule order with `FOR UPDATE SKIP LOCKED`. Claiming increments the attempt, creates a `job_attempts` row, and grants a time-bounded lease. Starting, heartbeating, completing, failing, cancelling, and releasing require a current lease owner. The configured lease must exceed twice the heartbeat interval.

Retryable classes are provider rate limit, provider server error, network, storage, timeout, and unknown failures. Backoff defaults to one second, doubles by attempt, caps at sixty seconds, applies ±20 percent jitter, and uses a larger provider `Retry-After` as a lower bound. A retryable failure with attempts remaining enters `RETRY_WAIT`; exhausted retryable work enters `DEAD_LETTER`. Validation, security, budget, and user-input failures enter `FAILED` without automatic retry. Stored errors are bounded and scrub common bearer/token/secret forms.

Each transition appends a `job_events` record. Each attempt records its worker, result, error class, bounded error, retry delay, and completion time. Job details expose both histories.

## Lease recovery and shutdown

Every poll cycle first searches for expired `CLAIMED`, `RUNNING`, or `CANCELLATION_REQUESTED` leases:

- an unfinished attempt with attempts remaining moves to `RETRY_WAIT`;
- an unfinished final attempt moves to `DEAD_LETTER`;
- an expired cancellation request becomes `CANCELLED`;
- the prior attempt is marked `LEASE_EXPIRED`;
- linked research run/stage state is reconciled when the outcome is terminal.

On `SIGINT` or `SIGTERM`, the worker stops claiming, reports `DRAINING`, waits for the configured grace period, aborts remaining handlers, and releases their leases. Released normal work returns to `RETRY_WAIT`; released cancellation work becomes `CANCELLED`. Handlers receive an `AbortSignal`, but libraries or external calls that ignore it may continue until their own timeout. The lease fence prevents such stale work from committing after ownership changes.

## Cancellation and manual recovery

Cancellation is cooperative:

- queued or retry-waiting work becomes `CANCELLED` immediately;
- claimed/running work becomes `CANCELLATION_REQUESTED`;
- heartbeat observation aborts the handler and the worker acknowledges `CANCELLED`;
- lease expiry also finalizes an unacknowledged cancellation;
- cancelling a research run requests cancellation for its active jobs and reconciles the run only after active work has stopped.

Do not describe a cancellation response as proof that an external provider stopped processing. It proves only the stored request and eventual local acknowledgement.

Manual job retry accepts only `FAILED` or `DEAD_LETTER` non-pipeline jobs and grants one additional attempt. Pipeline work must use the stage-rerun operation. Stage rerun creates a new generation, preserves history, marks downstream generations stale, and enqueues work against the frozen input. Resume operates only on resumable run states. Operator operations require authenticated principal-derived audit identity, CSRF verification, and a stable `Idempotency-Key` header. Project jobs additionally require their exact project scope. The sole null-scope exception is a system-scoped `STORAGE_CLEANUP` job, such as cleanup retained after project deletion; the job API and operator UI permit retry/cancel for that type only and reject null scope for every other system or project job.

## Research orchestration

`research-pipeline.v2` contains eleven ordered stages:

1. `intake_analysis`
2. `question_decomposition`
3. `research_plan`
4. `source_summary`
5. `evidence_extraction`
6. `claim_generation`
7. `gap_detection`
8. `conflict_detection`
9. `report_outline`
10. `draft_generation`
11. `qa_revision`

A run freezes scope/plan revisions, pipeline version, provider/model configuration, budget, and request hash. A plan must be approved before run creation. Each stage has explicit dependencies, prompt and structured-schema versions, timeout, and maximum attempts. Provider output is parsed by the stage schema and every referenced source ID is checked against the stage allowlist before any domain effect is committed.

Stage commits can add or update questions, sources, evidence, claims, gaps, conflicts, outlines, report revisions, and QA revision material. They do not approve the plan, resolve deterministic QA authority, approve the deliverable, or deliver an export. Human plan approval and final approval remain separate actions.

Persisted export generation runs through the durable queue. `POST /api/projects/:projectId/exports/:format` freezes an export snapshot under the caller's centrally receipted idempotency key and submits `GENERATE_EXPORT`; the worker checks cancellation and the current database-time lease/attempt before finalizing one verified object, export row, and generation audit event. `GET` is download-only and never persists, including ZIP. The approval-page download action queues the POST before issuing the read-only GET; legacy `?persist` GET requests are rejected.

## Budgets and provider capacity

The default frozen run budget is 40 provider requests, 30 search requests, 500,000 input tokens, 100,000 output tokens, USD 25 estimated cost, one hour elapsed time, three stage attempts, 100 sources, and 2,000 document chunks. Run creation can freeze different validated limits.

Before a provider call, the worker checks stored usage plus the next request. Cost is `KNOWN`, `ESTIMATED`, or `UNKNOWN`. The deterministic mock price is known zero. A live model without a matching `MODEL_PRICING_JSON` entry remains unknown; with a finite cost budget the call is blocked rather than priced as zero.

PostgreSQL-backed provider windows enforce request count and concurrent in-flight permits across processes. Permits have a TTL for crash recovery and are released after execution. They limit the workbench; they do not replace provider account quotas or billing alerts.

## Observability

The operator surfaces are `/operations`, `/jobs`, `/runs`, `/documents`, `/evaluations`, and `/audit`. Authenticated APIs expose job attempts/events, run generations, worker heartbeats, provider execution/canary history, evaluations, and aggregate metrics.

| Signal | Source |
| --- | --- |
| Web health | Public `GET /api/health`: configuration, PostgreSQL, object storage, auth mode, demo/live mode |
| Worker health | `GET /api/workers/readiness?workerId=...` or `WORKER_ID=... npm run worker:readiness` |
| Queue | Depth, oldest age, running, retry, failed, dead-letter counts from `GET /api/metrics` |
| Workers | READY versus stale heartbeat counts and `GET /api/workers` detail |
| Providers | Request/failure/retry counts, latency, tokens, cost status, execution history, permits, canaries |
| Stages | Succeeded/failed/blocked counts and duration |
| Documents | Uploaded bytes, scan/extraction duration, infected/rejected and extraction failures |
| QA/exports | Open blockers, artifact count, and persistence duration |
| Logs | JSON lines from the worker with service, worker/job/run/stage identifiers and bounded errors |
| Audit | Project-scoped and global operator/system mutations in `audit_events` |

`GET /api/health` does not prove worker readiness, ClamAV readiness, provider credentials, or end-to-end research completion. Metrics are lifetime database aggregates, not a Prometheus endpoint, trace system, SLO, or alerting service. Logs are local stdout/stderr unless the deployment supplies a collector.

## Operator runbook

### Queue is growing

1. Check `/operations` and `/jobs` for job types and oldest queued age.
2. Check `/api/workers` for a READY, non-stale worker with matching handlers.
3. Check worker logs for `worker.poll_failed` and database connectivity.
4. Confirm `scheduled_at` has passed and attempts are below the maximum.
5. Confirm lease/heartbeat configuration is valid; do not shorten a lease below twice the heartbeat.
6. Start or replace the worker. Do not update job rows manually.

### Jobs repeatedly retry

Inspect attempt error classes and events. Provider rate-limit failures should include a bounded retry delay; storage failures require checking the configured provider and integrity; timeouts may indicate a stage-specific limit or a blocked dependency. A final retryable failure becomes `DEAD_LETTER`. Fix the cause before manual retry.

Job input and output references are JSON-serialized and measured as UTF-8 before any JSONB write, with a 4 MiB limit for each reference. Invalid or oversized input is rejected at submission; invalid or oversized handler output fails terminally as non-retryable validation rather than repeatedly filling the queue. Large documents and generated deliverables belong in private object storage with bounded database references, not in job payloads.

### A worker disappeared

Wait until its lease expires. A healthy worker's next poll recovers the job. Starting multiple workers is supported because claiming uses row locks and leases. Never clear lease columns by hand; doing so can defeat stale-attempt fencing and destroy evidence.

### A run is blocked or failed

Inspect the current stage, provider execution, budget status, allowed source references, and job history. Fix user input, provider configuration, or pricing first. Resume only when the run status permits it. Use stage rerun for a new generation; do not manually retry its job.

### Cancellation appears stuck

Check whether the job still has a current worker heartbeat. The state remains `CANCELLATION_REQUESTED` until the handler observes the abort or the lease expires. If an external call ignores cancellation, wait for its timeout and lease reconciliation. Do not claim that remote processing was cancelled unless the remote provider supplies that evidence.

### Scanner or storage is unavailable

Uploads remain quarantined or become `BLOCKED_SCANNER_UNAVAILABLE`; extraction must not proceed. Verify storage credentials/bucket access and ClamAV readiness, then submit a new scan request. Production is fail closed.

### Migration fails

The failing migration transaction is rolled back. Preserve logs, correct the deployment/configuration issue, and rerun the same command. If an earlier migration already committed, follow the forward-only recovery policy in [Migrating from v0.1](MIGRATING_FROM_V0_1.md); never edit its SQL.

## Commands

```bash
npm run doctor
npm run dev:all
npm run worker
npm run worker:readiness
npm run smoke:research-run
npm run cleanup:orphans
npm run cleanup:orphans -- --help
npm run docs:validate
```

`npm run cleanup:orphans` is dry with respect to untracked objects unless `--delete-untracked` is passed. Run the opt-in untracked deletion only while artifact writers and workers are quiesced because its catalog comparison is a point-in-time reconciliation. Untracked reconciliation walks every provider page in one pass; `--limit` bounds each storage/catalog page rather than the total scan, so tracked or recent early keys cannot starve later orphans. For cataloged pending deletions, the command revalidates the unexpired database-time lease under a row lock and holds that lock through physical deletion and the catalog commit; worker claim owners are attempt-scoped, expired claims are reported without deleting, and failed storage operations release the claim for retry or reactivation. The command exits nonzero while a tracked failure or additional pending batch remains. Project-deletion jobs target the object IDs recorded by the deletion transaction, drain successive bounded batches, and retry instead of succeeding when any target remains pending. Worker cancellation is observed between cleanup operations, and migrated local paths are accepted only as contained regular files below the configured `uploads/` or `exports/` root. Deletion is material: inspect the selected storage provider, bucket, grace period, and report before enabling it.
