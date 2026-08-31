# Changelog

All notable changes are documented here. The project follows release tags rather than promising semantic-version compatibility for an unversioned public API.

## 0.2.0 - 2026-08-31

### Added

- Separate durable worker with PostgreSQL claiming, leases, heartbeat, attempts, timeout, retry/backoff, cooperative cancellation, dead-letter state, lease recovery, graceful shutdown, and worker readiness.
- Eleven-stage `research-pipeline.v2` orchestrator with approved revision snapshots, frozen provider/model/budget configuration, stage generations, prompt/schema versions, provider provenance, source-ID validation, stale-attempt fences, and transactional idempotent domain commits.
- Jobs, runs, operations, documents, evaluations, sessions, and provider/worker operational pages and authenticated APIs.
- Minimal named-operator authentication: Argon2id passwords, HMAC-hashed opaque sessions, SameSite/HttpOnly cookies, double-submit CSRF and origin checks, PostgreSQL login throttling, session listing/revocation, and password rotation.
- Trusted principal-to-audit-actor mapping for authenticated mutations; HTTP input can no longer select a system actor. Job/run actions record stable operator identity and request idempotency state.
- Durable HTTP mutation receipts with principal/method/path/request hashes, exact bounded JSON replay, query/body drift rejection, concurrent duplicate serialization, cookie-aware auth replay, and browser retry-key retention.
- Local and S3-compatible private object storage with contained keys, exclusive/conditional writes, size/SHA-256 verification, catalog lifecycle, bounded signed downloads, and orphan reconciliation.
- Durable document quarantine, ClamAV scan jobs, fail-closed disposition, PDF/DOCX/TXT/HTML/Markdown/CSV/JSON extraction, bounded archive/XML/text processing, structure-aware chunks, citation anchors, prompt-injection signals, and citation review invalidation after re-extraction.
- Database-backed provider request/concurrency permits, execution history, token/cost provenance, known/estimated/unknown pricing, frozen run budgets, and bounded failure classification.
- Ten-fixture deterministic mock evaluation and optional synthetic OpenAI/Brave compatibility canary. Normal tests remain key-free and network-independent.
- Integrity-aware persisted exports with canonical input hashes, reusable verified objects, stale/current state, persistence failure recovery, duration metrics, and structural release verification.
- Exact-commit release evidence packaging: configuration/job/pipeline schemas, mock evaluation, synthetic evidence bundle, sample PDF/DOCX, an explicitly unapproved non-final preview ZIP, and an exact SHA-256 manifest.
- Strict documentation/management metadata validator covering schemas, global duplicate IDs, complete package commands/workflows/doc index, declared routes/method exports, repository paths, and local Markdown links.

### Changed

- Package version is 0.2.0 and minimum Node.js is 22.13.
- Development web binds to loopback; `npm run dev:all` runs web and worker together.
- Compose now supplies PostgreSQL, private MinIO, ClamAV, migration, web, and worker from one immutable non-root image with loopback-published ports.
- Research pipeline work is automatically sequenced by the worker after an approved plan; provider output remains reviewable and cannot grant QA or approval authority.
- Uploads entering the durable document path are quarantined and scanned before extraction. The mock scanner remains a local fixture only.
- Persisted exports use the object-storage abstraction rather than trusting an absolute local file path.
- Export GET is download-only; durable persistence is submitted through the centrally idempotent POST job path.
- Migrations use a session advisory lock, per-file transactions, and SHA-256 checksums; applied files are immutable.
- CI is split into quality, integration, document security, provider contract, evaluation, authenticated browser, and full-container lanes. The optional live canary remains separate from required CI.

### Delivery semantics

- The job queue is **at least once, not exactly once**. Idempotency keys, canonical input/output hashes, generations, worker/attempt fences, and domain-commit records prevent known duplicate/stale local commits. Provider/external effects can still repeat around failure boundaries and require reconciliation.
- Queued work cancels immediately; claimed/running work remains `CANCELLATION_REQUESTED` until worker acknowledgement or lease expiry. Local cancellation does not prove that a remote provider stopped.
- Generic manual retry is limited to failed/dead-letter non-pipeline work. Pipeline recovery creates a new stage generation.

### Security and compatibility notes

- Production runtime requires auth enabled, secure cookies, a 32+ character session secret, no auth bypass, ClamAV, fail-closed malware policy, and no scan bypass.
- Demo auth bypass is restricted to non-production demo mode and loopback configured URL, bind, and request host.
- Authentication is minimal single-installation operator identity, **not** roles, project/workspace authorization, or tenant isolation. MFA/SSO/recovery and public signup are absent.
- ClamAV is signature-based, buffers bounded objects, and is not content disarm or a guarantee against malware. Default scan/object ceiling is 25,000,000 bytes and timeout is 15 seconds; upload defaults to 5,242,880 bytes.
- Extraction supports PDF text layers, bounded DOCX, UTF-8 TXT, and sanitized HTML. OCR, encrypted documents, image extraction, arbitrary file formats, full layout fidelity, and active content are not supported.
- Prompt-injection detection is heuristic; flags require review and do not make content safe.
- Mock providers/evaluation prove deterministic fixture behavior only. Live calls are optional, billable, externally transferred, and canary-tested for compatibility rather than accuracy.
- Unknown live model price remains `UNKNOWN` and blocks a finite-cost request rather than becoming zero.

### Migration

- Upgrade v0.1 in place with a verified PostgreSQL backup and matching private artifact/object snapshot, then run `npm run db:migrate` twice and bootstrap an operator.
- Legacy project text IDs remain compatible. Legacy approvals/jobs/storage/export metadata are backfilled into the new contracts; legacy export bytes require real integrity verification or regeneration.
- Migrations are forward-only. After a migration commits, rollback means restoring the matching pre-upgrade database/object snapshots or shipping a reviewed forward fix. There are no down migrations; never edit an applied file.

See [Migrating from v0.1](docs/MIGRATING_FROM_V0_1.md), [Operations](docs/OPERATIONS.md), [Document pipeline](docs/DOCUMENT_PIPELINE.md), [Authentication](docs/AUTHENTICATION.md), and [Limitations](docs/LIMITATIONS.md).

## 0.1.0

- Initial evidence-first local MVP with the normalized research graph, deterministic QA, approval/export workflow, mock/optional provider adapters, safe URL/file ingestion primitives, synthetic fixture, and baseline browser/integration tests.
