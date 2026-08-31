# Limitations

## Deployment boundary

v0.2.0 is a controlled local/internal MVP, not a public or multi-tenant service. Its production-mode configuration checks prevent several unsafe combinations, but they do not supply TLS termination, network policy, a secret manager, database TLS, managed backups, point-in-time recovery, retention governance, alerting, or incident response.

The Compose ports are loopback-bound and use local fixture credentials. Replace every credential and review the topology before sharing a host. The start script binds broadly for container use; network exposure must be controlled outside the process.

## Identity and authorization

Named operators, durable sessions, password rotation, session revocation, origin checks, CSRF tokens, and login throttling are implemented. Roles, approver permissions, project/workspace membership, tenant isolation, row-level security, storage tenant boundaries, MFA, SSO, recovery, invitations, public signup, and admin lifecycle are not.

All authenticated operators share the installation's project access. Client/workspace/security-classification fields are domain metadata, not authorization. Audit events are ordinary PostgreSQL rows, not cryptographically signed or externally tamper-evident.

## Jobs and recovery

PostgreSQL leases, retries, dead-letter state, cancellation, recovery, and idempotent run-stage commits are implemented. Delivery is at least once, not exactly once. External providers can be billed or process a request more than once around lease/acknowledgement failures. Cancellation proves a local request/acknowledgement, not remote cancellation.

There is no automated dead-letter remediation, operator paging, cross-region queue, priority fairness guarantee, distributed trace backend, or exactly-once side-effect framework. Graceful shutdown relies on handlers and dependencies honoring abort/timeouts.

## Documents and storage

The durable extractor supports PDF text layers, bounded DOCX OOXML, UTF-8 TXT, and sanitized HTML. It does not support OCR, scanned-image transcription, image/media extraction, spreadsheets/presentations, password-protected files, arbitrary encodings, full PDF rendering, full Word layout, or content disarm and reconstruction.

ClamAV is signature-based and cannot guarantee safety. Embedded content coverage is bounded, the scanner buffers objects in memory, and signature freshness is an operator responsibility. The mock scanner is a fixture only.

Local and S3-compatible storage enforce application-level containment/integrity. The repository does not configure encryption keys, IAM policy, object lock, replication, lifecycle, legal hold, backup, restore, or automatic retention. Orphan cleanup is explicit and deletion can be irreversible.

## Research and model authority

Mock providers are deterministic fixtures, not real research. Live OpenAI/Brave behavior is optional, external, billable, and only compatibility-canary checked. The system does not autonomously establish truth, source licensing, safe redistribution, representativeness, or factual completeness.

Structured schemas and source-ID allowlists constrain output; prompt-injection heuristics can still miss hostile instructions or flag benign text. Search snippets are not verified page evidence. Human review, deterministic QA, plan approval, and final approval remain authoritative.

The mock evaluation corpus has ten labeled synthetic fixtures. Its scores measure that corpus and do not generalize to customer accuracy. `eval:live` deliberately does not assign an unlabeled accuracy score.

## Budgets and capacity

Run budgets, shared provider permits, elapsed time, token counts, source/chunk counts, and known/estimated/unknown cost state are implemented. Unknown live pricing blocks bounded calls instead of becoming zero.

Budgets are local application controls. They do not replace provider account limits, billing alerts, organization quotas, or reconciliation. Metrics are lifetime database aggregates and lack retention windows, SLOs, alert thresholds, and cardinality governance. No load or capacity claim is made for large teams/documents.

## UI and accessibility

The responsive application exposes major workflow and operations screens. Playwright covers authenticated desktop Chromium, iPhone 13 emulation, and auth behavior. It is not a full keyboard/focus/screen-reader/WCAG audit, cross-browser matrix, visual regression system, localization review, or assistive-technology certification.

Complex tables can still require horizontal scrolling on small screens. Dense research records, empty/error states, destructive confirmation behavior, and long translated content need broader browser evidence.

## Exports and delivery

PDF, DOCX, Markdown, HTML, CSV, and ZIP are structurally tested. Visual fidelity, font coverage, pagination, office-suite compatibility, archival formats, digital signatures, document encryption, watermarking, and recipient delivery are environment-dependent or absent.

Final ZIP generation requires current approval and no unresolved blocker. The application does not email, upload to a client portal, notify reviewers, or prove recipient receipt. A SHA-256 digest proves byte identity only when compared to a trusted expected value; it is not a signature.

## Operations and lifecycle

Migrations are forward-only. There is no down-migration engine; rollback after a committed migration is restore of a matching database/object snapshot or a forward fix. Backup/restore drills and retention policies are deployment responsibilities.

There is no supported public SLA, on-call integration, telemetry exporter, distributed tracing backend, SIEM integration, vulnerability-management program, dependency update service, or automatic disaster recovery. The repository's CI and diagnostics are evidence tools, not an operations organization.
