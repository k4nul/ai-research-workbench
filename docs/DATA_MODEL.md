# Data model

## Storage and migration contract

PostgreSQL is accessed directly through `pg`; there is no ORM. Ordered raw SQL lives in `migrations/`. The migration runner serializes with an advisory lock, applies each new file transactionally, and records filename/checksum in `schema_migrations`. Applied files are immutable and forward-only.

Raw document, promoted clean-source, generated extraction/evaluation, and export bytes live in the configured object storage; PostgreSQL stores their catalog, integrity, lifecycle, and graph references. Database and object storage must be backed up/restored together.

## Research graph

```text
workspaces -> clients -> research_projects
                         |-> approval_revisions
                         |-> research_questions -> research_plans
                         |-> sources -> evidence
                         |              ^    |
                         |              | claim_evidence
                         |-> claims -----+ -> findings -> finding_claims
                         |-> deliverables -> deliverable_revisions
                         |-> qa_findings -> project_exports
                         +-> audit_events
```

The source/evidence/claim/finding/deliverable links are explicit and project-scoped. Workspace/client classifications are organization metadata, not authorization.

## Durable execution

| Tables | Purpose |
| --- | --- |
| `approval_revisions` | Immutable scope/plan snapshots and approvals frozen by runs |
| `research_runs` | Pipeline/config/budget/request snapshot, aggregate usage, status |
| `research_run_stages` | Stage identity, ordinal, generation, versions, hashes, usage, result/error |
| `jobs` | Authoritative queue row, project/run/stage links, idempotency/input/output, attempts, lease, retry/cancellation |
| `job_attempts` | Per-attempt worker/status/error/retry history |
| `job_events` | Append-style transition history and bounded details |
| `stage_domain_commits` | Unique generation/idempotency/output proof committed with domain effects |
| `worker_heartbeats` | Worker version/status/capacity/activity/readiness |
| `mutation_receipts` | Principal/method/path/key scope, request hash, exact bounded JSON status/body, completion time |

Job delivery is at least once, not exactly once. Unique keys and fenced domain commits constrain replay; they do not eliminate duplicate external calls. HTTP receipts are separate: central database-only mutations commit their receipt, domain effect, and audit atomically, while multipart uploads rely on their document/object/job-specific durable keys.

AI-generated `evidence`, `claims`, `findings`, and `qa_findings` carry a nullable
`generated_by_run_stage_id` plus `is_current`. Manual rows have no generating
stage and remain current. Restarting a stage atomically makes its generated
effects and those of stale descendants non-current; the new generation becomes
current only when its fenced domain commit succeeds. Historical rows and the
immutable stage output remain available for inspection, while normal project,
ledger, finding, and QA reads exclude non-current generated effects.

AI-generated open research gaps record `gap_generated_by_run_stage_id` on the
question. Staling that generation can clear an unreviewed open gap, but never
clears a human `ACCEPTED` or `RESOLVED` decision. Human-edited deliverable
sections are similarly protected; a later draft generation may replace only
sections still owned by prior AI revisions.

## Providers and evaluation

| Tables | Purpose |
| --- | --- |
| `ai_runs` | Legacy/explicit typed pipeline invocation provenance |
| `provider_executions` | Provider/model operation, request/response IDs, hashes, usage, cost, latency, errors |
| `provider_rate_windows` | Shared request-window and in-flight counters |
| `provider_permits` | TTL-owned concurrency permits for crash recovery |
| `provider_canary_runs` | Synthetic optional live compatibility outcomes |
| `evaluation_runs` | Mock/live-not-run evaluation metadata, metrics, local paths, and private object references |

Cost state is `KNOWN`, `ESTIMATED`, or `UNKNOWN`; unknown is preserved rather than mapped to zero.

## Documents and objects

| Tables | Purpose |
| --- | --- |
| `storage_objects` | Provider/bucket/key, MIME/name, size/hash, integrity/upload/scan/extraction/retention, project/source |
| `documents` | Source/quarantine object, processing status, scan bypass, current extraction, upload idempotency |
| `document_scan_results` | Immutable scanner/version/signature/result/duration/object hash |
| `document_extractions` | Per-document extraction version, extractor, status, content hash, confidence, warnings, private JSON artifact object |
| `document_blocks` | Ordered structural text with offsets/location/hash/stable anchor |
| `document_chunks` | Bounded text chunks, block bounds, chunker version, security signals |
| `citation_anchors` | Source/document/extraction/chunk offsets/hash and current/stale/review state |
| `project_exports` | Deliverable/format, object reference, input hash, byte hash/size, persistence/current state |

A real clean scan promotes byte-identical content to a generated `sources/` object while retaining the quarantine object as scanner provenance; demo bypass does not claim promotion. A successful re-extraction makes older current anchors and linked evidence citations require review and writes a checksummed `extractions/` JSON artifact. Storage-object metadata is not sufficient proof of bytes; adapters verify size/hash on relevant reads.

## Identity and audit

| Tables | Purpose |
| --- | --- |
| `operators` | Normalized identity, Argon2id hash, activity/password version |
| `operator_sessions` | HMAC token/CSRF hashes, expiry/revocation/client fingerprint |
| `operator_login_rate_limits` | Durable failed-attempt window and block time |
| `audit_events` | Project/global actor type/label, action, resource, before/after state, time |

Audit actors are derived from authenticated principals or bounded system contexts for HTTP/worker operations. Audit rows are not cryptographically chained and remain mutable by privileged database users.

## State and integrity rules

- Foreign keys maintain graph ownership and apply deliberate cascade/set-null behavior.
- Check constraints bound enumerated statuses and numeric/hash shapes.
- Services lock the project before project-scoped mutable records to keep lock order consistent.
- Material workflow changes invalidate QA/approval/current exports.
- Only a resolved blocker clears delivery; accepted-risk blocker remains blocking.
- Run-stage generations preserve stage/output and domain-effect history; downstream generations become stale after restart and only current generated effects feed normal reads.
- Object/catalog writes use reservation/finalization or compensation so partial state is visible and recoverable.
- HTTP idempotency scope includes principal, method, pathname, key, raw query, content type, and bounded body; reuse with changed input is a conflict.

## JSONB use

JSONB stores versioned/flexible snapshots and provenance: scope/plan snapshots, stage/job/provider input/output, budgets/config, retry policy, report sections, usage, scanner/extractor metadata, security signals, audit before/after state, and evaluation summaries. Services parse external/model JSON before persistence and revalidate structured output when replaying.

JSONB does not relax project ownership or authoritative state checks. Fields that drive joins, uniqueness, leases, lifecycle, approval, and integrity remain normalized.

## Deletion and retention

Project/document/object deletion is material. Database cascades, catalog retention state, and backing-object cleanup can fail at different points; services record/report reconciliation needs. Orphan cleanup is explicit and does not delete untracked objects without an opt-in flag and grace period.

There is no soft-delete restore, automatic backup, retention scheduler, or legal-hold workflow. Follow [Document pipeline](DOCUMENT_PIPELINE.md), [Operations](OPERATIONS.md), and [Migrating from v0.1](MIGRATING_FROM_V0_1.md).
