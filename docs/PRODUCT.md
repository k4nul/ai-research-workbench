# Product

## Product statement

AI Research Workbench helps a small controlled research team turn a scoped brief into an evidence-traceable, QA-checked, human-approved delivery package. It keeps the reasoning between a source and report visible and gives operators durable execution/recovery evidence without requiring live provider keys.

## Users and jobs

| User | Primary job |
| --- | --- |
| Research operator | Scope work, acquire sources, review evidence/claims/findings, supervise runs |
| Reviewer | Inspect provenance, conflicts, gaps, revisions, and QA blockers |
| Approver | Record an explicit final decision after QA and review |
| Operations owner | Monitor queue/workers/providers/documents/evaluations and recover failures |

v0.2 authenticates named operators, but does not enforce these workflow roles as permissions. Every authenticated operator shares access to the installation.

## Principles

- Evidence before prose: preserve source → evidence → claim → finding → deliverable.
- Deterministic gates remain authoritative: a model cannot approve or clear QA blockers.
- Human approval is explicit and invalidated by material downstream change.
- Every durable mutation has project scope and audit/provenance.
- External content, uploads, and model output are untrusted.
- Mock providers are the default; live calls are deliberate and isolated.
- Queue delivery is at least once, so effects must be idempotent and recoverable.
- File/route/status existence is not completion evidence; behavior must run.

## v0.2 capability

- Responsive dashboard, project workflow, provenance/detail, report/revision, QA/approval/export, audit, sessions, operations, jobs, runs, documents, evaluations, and provider screens.
- PostgreSQL research graph, approval revisions, progress invalidation, audit events, and strict blocker semantics.
- Minimal operator auth with Argon2id, opaque durable sessions, CSRF/origin checks, login throttling, password rotation, and session revocation.
- Durable worker leases, heartbeat, attempts, retry/backoff, cancellation, timeout, recovery, dead letter, and operator actions.
- Eleven-stage orchestrator with frozen revisions/config/budget, source allowlists, shared provider permits, generations/fences, and idempotent domain commits.
- Manual/search/safe-fetch/import/reuse sources plus quarantined PDF/DOCX/TXT/HTML/Markdown/CSV/JSON scan/extraction/chunk/anchor flow.
- Contained local or private S3-compatible storage, ClamAV integration, and integrity-aware export persistence.
- Deterministic mock AI/search, optional OpenAI/Brave, bounded live canary, ten-fixture mock evaluation, and usage/cost provenance.
- Markdown, HTML, PDF, DOCX, CSV, and approval-gated ZIP generation.

## Completion definition

A research package is ready for delivery only when:

1. scope and plan revisions are approved;
2. critical questions and accepted gaps are explicit;
3. claims link to project-owned evidence and source provenance;
4. report requirements are present;
5. deterministic QA has no unresolved blocker;
6. a named operator records final approval;
7. a current ZIP is generated from the unchanged approved snapshot;
8. the artifact bytes/hash can be read from private storage.

A completed background run is not a completed research project. A passing mock eval is not live research accuracy. A generated file is not final delivery without the approval/currentness gates.

## Boundary and non-goals

The current product is local/internal and single-installation. It is not a public autonomous research agent, multi-tenant SaaS, source-of-truth oracle, web crawler, paywall bypass, billing marketplace, public portal, or real-time collaborative editor.

Roles/tenant isolation, MFA/SSO, public deployment controls, managed backup/retention, OCR, full office-format fidelity, recipient delivery, and exactly-once execution are not implemented. See [Limitations](LIMITATIONS.md) and [Roadmap](ROADMAP.md).

## Verification evidence

Use [Testing](TESTING.md) for executable lanes, [Operations](OPERATIONS.md) for recovery semantics, and [Migrating from v0.1](MIGRATING_FROM_V0_1.md) for forward-only upgrade/rollback. Screenshots and management metadata are navigation/documentation aids, not proof of product completion.
