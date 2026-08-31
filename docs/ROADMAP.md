# Roadmap

## Status discipline

This roadmap is a prioritized evidence backlog, not a schedule. An item is complete only when implementation, negative cases, operator documentation, and the relevant unit/integration/browser/deployment evidence pass on the target revision. Management metadata, file existence, screenshots, or a declared status cannot make progress 100 percent.

## v0.2 baseline

The current baseline includes:

- named local operators, durable sessions, origin/CSRF checks, session management, and database-backed login throttling;
- a PostgreSQL at-least-once job queue with leases, attempts, retries, timeout, cancellation, dead letter, recovery, heartbeats, and operations views;
- eleven-stage versioned orchestration with frozen revisions/config/budgets, shared provider permits, source allowlists, run-stage generations/fences, and idempotent domain commits;
- local or S3-compatible private object storage, quarantine, ClamAV integration, bounded PDF/DOCX/TXT/HTML/Markdown/CSV/JSON extraction, chunks, anchors, and prompt-injection signals;
- deterministic mock providers/evaluation and optional bounded live canaries;
- strict QA, explicit approval, integrity-aware PDF/DOCX/CSV/ZIP persistence, and a release evidence pipeline;
- focused unit/contract/integration lanes plus authenticated desktop/mobile Chromium workflows and full-container smoke execution.

The baseline remains subject to [Limitations](LIMITATIONS.md).

## Priority 0: release correctness

- Keep documentation/management validation, lint, typecheck, unit, provider contract, database integration, document security, build, browser E2E, mock evaluation, full-container smoke, and release artifact verification green on the exact release commit.
- Complete a v0.1 restored-copy upgrade rehearsal and a forward-only restore/forward-fix exercise, including matching object storage.
- Inspect release PDF/DOCX/ZIP in target viewers and record fonts, language coverage, pagination, table behavior, and checksums.
- Exercise worker crash after provider success/before acknowledgement, stale stage attempts, lease expiry, duplicate idempotency keys, and cancellation during each external dependency.
- Establish a repeatable dead-letter and legacy export-integrity reconciliation runbook with non-destructive evidence.

## Priority 1: authorization and tenancy

- Define workspace membership, project permissions, named approver role, least privilege, and service identities.
- Enforce authorization in the data-access layer and storage namespace, then add hostile cross-tenant ID tests for every route and export.
- Add MFA/SSO or a deliberate alternative, recovery, invitation/deactivation lifecycle, session/device policy, and privileged-action reauthentication.
- Define trusted proxy/origin configuration, distributed abuse controls, and public deployment conditions.
- Export audit/security events to a restricted tamper-evident sink with retention and incident access policy.

## Priority 2: document and data lifecycle

- Add OCR with language/model provenance and confidence; preserve the original image/page anchor.
- Expand safe format support only with bounded parser, archive, active-content, and malicious-fixture tests.
- Define object encryption, IAM, lifecycle, retention, legal hold, deletion, restore, and cross-store reconciliation.
- Stream or stage large scans/extractions instead of buffering whole objects when the security design can preserve hashes and bounds.
- Add content-disarm/sandbox decisions for high-risk formats and operational evidence for ClamAV signature freshness/outage.

## Priority 3: reliability and observability

- Add metrics export, bounded labels, dashboards, SLOs, alerts, trace correlation, and log redaction/retention.
- Add managed backup, point-in-time recovery, restore drills, connection pooling, capacity/load tests, and failure injection.
- Add automated but approval-gated dead-letter remediation and provider/object reconciliation.
- Strengthen external idempotency where providers support it and expose possible duplicate billing/requests clearly.
- Define horizontal worker scaling, graceful rollout, queue fairness, and version compatibility between web, worker, schema, prompts, and jobs.

## Priority 4: research quality and collaboration

- Build larger representative labeled eval sets with slice metrics, adjudication, drift history, and explicitly separated live compatibility versus accuracy.
- Add reviewer assignments, comments, saved filters, handoff queues, and redacted read-only client review.
- Improve prose-to-claim mapping, numeric/date/unit/scope normalization, citation styles, and conflict/gap review without giving a model pass/fail authority.
- Add multilingual research/export validation with configured fonts and anchor/OCR evidence.
- Measure cycle time, evidence coverage, blocker recurrence, reviewer effort, provider cost, and post-delivery corrections.

## Deferred by design

- Autonomous approval or delivery.
- General crawling, paywall bypass, or indiscriminate data collection.
- Claims that a model or deterministic QA engine establishes truth.
- Public marketplace, billing, or self-service signup before authorization/tenancy exists.
- Real-time collaborative editing before durable conflict and audit semantics are designed.

## Exit evidence

Each milestone must name:

- the threat/failure model and acceptance criteria;
- focused positive and negative tests;
- browser evidence for visible/operator behavior;
- upgrade/rollback and operational runbooks where state is durable;
- artifact inspection for PDF/DOCX/ZIP changes;
- live canary evidence kept separate from deterministic quality evidence;
- updated architecture, security, testing, limitations, and management metadata.
