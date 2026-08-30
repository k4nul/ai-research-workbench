# Roadmap

## How to read this roadmap

This is an evidence-based list of remaining product work, not a delivery promise or schedule. “Implemented” means code exists in the current checkout. It does not mean production-ready or fully verified. Priorities should change only after real user evaluation and recorded acceptance evidence.

## Current foundation

- Next.js 16/React 19/TypeScript foundation, API routes, responsive shell, and UI primitives.
- PostgreSQL 17 normalized research model, raw migration tooling, synthetic seed, and a durable jobs-table contract.
- Project/scope/question/plan/source/evidence/claim/finding/report/QA/approval/audit/export services.
- Pure progress/freshness/support/citation/gap rules and fourteen-rule QA engine.
- Default deterministic mock AI/search and optional OpenAI/Brave adapters.
- SSRF-resistant fetch, file validation, sanitization, prompt-injection assessment, and response security headers.
- Markdown, HTML, PDF, DOCX, CSV, and approval-gated ZIP generation.
- Local Docker/Compose, CI configuration, diagnostics, pure unit tests, and PostgreSQL integration coverage for the main state machine.
- Desktop/mobile Playwright workflows covering navigation, intake through approval, provenance linking, report revisions, PDF/ZIP downloads, stale-package denial, and mobile control reachability.
- Browser-backed documentation screenshots plus structural parsing of PDF, DOCX, and ZIP artifacts.
- CSV spreadsheet-formula neutralization and tests distinguishing repeated prose citations from duplicate structured source IDs.

## Priority 0: keep the local MVP verifiable

- Keep lint, typecheck, unit, PostgreSQL integration, build, desktop/mobile Playwright, Docker health, and artifact checks green in CI and record exact results for each release.
- Expand keyboard, focus-order, screen-reader, destructive-confirmation, empty/error, and cross-browser coverage beyond the current Chromium baseline.
- Add browser coverage for project deletion and private-file cleanup, including an injected cleanup-failure path.
- Perform target-office visual inspection for PDF/DOCX, select and verify `PDF_FONT_PATH` for required languages, and retain representative approved artifacts outside normal CI when policy permits.
- Map arbitrary report prose to normalized claims so fact/inference and scope rules cover more than claim-ledger statements without relying on a model for authority.
- Keep fixture rule codes aligned with canonical definitions and version any future historical vocabulary.
- Add load/resource measurements for large reports, exports, and project graphs; the current local in-process path is not a performance claim.

## Priority 1: finish controlled ingestion and AI orchestration

- Put the existing file-upload, URL-fetch, search, and import routes behind production authorization before any public deployment.
- Quarantine uploads; add malware scanning, robust PDF/DOCX parsing, archive limits, extraction provenance, and retention/deletion behavior.
- Wire Brave results through URL validation and safe fetching rather than treating result snippets as verified evidence.
- Extend the one-stage persisted pipeline into an explicit orchestrator with idempotency, retries, bounded cost/time/output, and user review before accepting generated records.
- Add provider integration fixtures and a separately approved live smoke lane; never require live keys in normal CI.
- Implement a job worker with leases, heartbeats, retries, cancellation, dead-letter visibility, and safe recovery, or remove the unused jobs contract.
- Improve report-prose citation, numeric, date, unit, scope, and conflict normalization without delegating pass/fail authority to a model.

## Priority 2: production security and operations

- Add production authentication, secure sessions, workspace membership, least-privilege roles, named approvers, and server-side authorization on every route.
- Define tenant isolation in PostgreSQL and storage, including tests for cross-tenant IDs and exports.
- Add CSRF/origin controls, trusted proxy configuration, distributed rate limiting, quotas, abuse monitoring, and provider spend limits.
- Deploy behind HTTPS with managed secrets, database TLS, network egress policy, hardened CSP without unnecessary inline allowances, and dependency/container scanning.
- Move artifacts to private durable object storage with encryption, signed/short-lived downloads, retention, deletion, legal hold, and integrity verification.
- Add managed PostgreSQL backups, point-in-time recovery, restore drills, migration release/rollback policy, pooling, and monitoring.
- Send structured audit/security logs to a restricted external sink; define alerts and incident response.

## Priority 3: research-team capabilities

- Reviewer assignments, comments, saved filters, and explicit handoff queues.
- Client-facing read-only review with redacted/allowlisted fields.
- Source library governance and safe cross-project reuse with license/usage restrictions.
- Citation-style rendering and stable reference ordering beyond source-ID citations.
- More expressive report tables and export styling with compatibility profiles.
- Multilingual research and export validation with explicitly configured fonts.
- Measurement of research cycle time, evidence coverage, blocker recurrence, reviewer effort, and post-delivery corrections.

## Deferred by design

- Autonomous approval or delivery.
- General web crawling or paywall bypass.
- Real-time collaborative document editing.
- Billing, marketplace, or public self-service signup.
- Claims that a model or QA engine can establish truth without source verification and human judgment.

## Exit evidence for each milestone

Every roadmap item should identify behavior-level proof before it is marked complete:

- focused unit/integration tests for rules and state changes;
- browser interaction evidence for visible workflows;
- negative security tests at each input/auth/tenant boundary;
- live-like artifact inspection for exports;
- deployment/restore/incident exercises for operations;
- updated architecture, security, workflow, and operator documentation.

Files, routes, database fields, configured scripts, seed statuses, screenshots, and project checkboxes are not sufficient proof on their own.
