# Architecture

## System shape

```text
Authenticated browser/API client
              |
              v
Next.js routes and pages (app, proxy.ts)
              |
              v
Auth/data-access + services (lib/auth, lib/services)
       |                    |
       v                    v
PostgreSQL queue/graph   Private object storage
       |                    |
       +------ worker ------+
                 |
        mock or live providers
```

The web and worker are separate processes built from the same image. PostgreSQL is authoritative for operators/sessions, the research graph, run/stage state, jobs/attempts/events, provider executions/permits, evaluations, object metadata, exports, progress, and audit history. Raw document/export bytes live in contained local storage or one configured private S3-compatible bucket.

## Code boundaries

| Path | Responsibility |
| --- | --- |
| `app/api` | HTTP/path/query/body parsing, authentication entry, status mapping |
| `app/**/page.tsx`, `components` | Server-rendered pages and client interactions |
| `proxy.ts` | Early public-path and session-cookie presence checks; not durable auth |
| `lib/auth` | Runtime constraints, password/session/CSRF primitives, principal DAL |
| `lib/services` | PostgreSQL transactions, project scoping, workflow/run/job/document/provider/export mutations, audit |
| `lib/domain` | Pure job, run, research, progress, and QA rules |
| `lib/execution` | Versioned eleven-stage catalog and dependencies |
| `lib/providers` | Typed mock/OpenAI/Brave adapters and structured-output boundary |
| `lib/budgets` | Frozen resource/cost limits and known/estimated/unknown pricing |
| `lib/documents` | Scanner, extraction, chunk, anchor, and document-state rules |
| `lib/storage` | Local/S3 object interface, containment, integrity, signed URLs |
| `lib/security` | SSRF-safe fetch, file validation, HTML sanitization, prompt-injection signals |
| `lib/export` | Snapshot loading and Markdown/HTML/PDF/DOCX/CSV/ZIP renderers |
| `worker` | Durable poll/lease loop and registered document/research handlers |
| `migrations` | Ordered additive raw SQL migrations |
| `scripts` | Setup, operator, worker probe, eval/canary, release, cleanup, validation |

Route handlers should not own database orchestration. Services should not render UI. Pure rules should not perform I/O. Provider/document/model text is untrusted at every layer.

## Request and identity flow

Public paths are login, auth login/session, and health. The proxy redirects requests without a session cookie, but APIs/pages then verify the HMAC-hashed opaque session against PostgreSQL. Unsafe API requests require an allowed `Origin`, double-submit CSRF proof, and a stable idempotency key. Authenticated JSON mutations atomically store a principal/method/path/request-hash response receipt with their database and audit effects; multipart uploads use the document service's byte-hash/object/job idempotency. Mutations derive a trusted audit actor from the request principal; actor type is not accepted from HTTP input.

The explicit demo bypass is restricted to non-production demo mode, loopback configured URL/bind, and loopback request host. It is not tenancy or a public deployment mode.

## Research graph and review flow

```text
project
  -> approved scope/plan revisions
  -> research questions
  -> sources -> evidence
  -> claims <-> evidence links
  -> findings
  -> deliverable revisions
  -> QA findings -> approval -> current ZIP
```

Material research changes invalidate downstream review/approval and mark earlier exports non-current. QA blocker semantics are strict: only `RESOLVED` clears a blocker. `ACCEPTED_RISK` does not clear blocker severity. Final delivery needs a current approved graph and newly current ZIP.

## Durable execution

Creating a run freezes revisions, pipeline/provider/model configuration, budget, and request hash, then creates versioned stage generations. The worker claims jobs with `FOR UPDATE SKIP LOCKED`, owns time-bounded leases, heartbeats, observes cancellation, applies retry policy, and recovers expiry.

Delivery is at least once, not exactly once. Job idempotency/input hashes, stage generations, attempt/worker fences, output hashes, and transactional domain-commit records reject known replay and stale-worker races. Provider execution and external side effects remain replayable and require reconciliation.

See [Operations](OPERATIONS.md) and [AI pipeline](AI_PIPELINE.md).

## Document and object flow

```text
validated bytes
  -> private quarantine object + source/document rows
  -> scan job -> ClamAV result
  -> extraction job
  -> extraction generation -> blocks -> chunks -> citation anchors
```

Object size/hash is verified on write/read/scan. Production is fail closed on scanner error. PDF/DOCX/TXT/HTML/Markdown/CSV/JSON parsers have explicit bounds and applicable active-content controls. A new extraction makes prior anchors and linked evidence citations require review. Exports use the same storage abstraction with input-hash reuse and byte verification.

See [Document pipeline](DOCUMENT_PIPELINE.md) and [Export formats](EXPORT_FORMATS.md).

## Provider and budget flow

Stage requests carry strict schemas, source allowlists, versioned prompts, input hashes, timeouts, and abort signals. Provider attempts are recorded independently of jobs and domain commits. PostgreSQL permits coordinate shared request windows/concurrency. Frozen budgets guard requests, tokens, elapsed time, attempts, sources, document chunks, and cost; unknown live pricing blocks finite-cost runs rather than becoming zero.

Mock providers are deterministic. Optional live OpenAI/Brave calls are isolated from normal CI and assessed only by a bounded synthetic canary. See [Providers, evaluation, and budgets](PROVIDERS_EVALUATION.md).

## Storage and migrations

PostgreSQL uses parameterized `pg` queries and transactions. JSONB is used for versioned snapshots, provider/job input/output, usage, metadata, and audit before/after state; normalized tables retain core relationships.

Migrations run in lexical order under a PostgreSQL advisory lock. Every new migration is transactional and checksum-recorded. Applied migrations are immutable and forward-only. Rollback after commit requires a matching database/object snapshot restore or a new forward fix. See [Migrating from v0.1](MIGRATING_FROM_V0_1.md).

## Deployment

The Dockerfile builds Next.js standalone output on Node 22 Alpine, installs Noto and Noto CJK fonts plus `tini`, and runs as UID 1001. The same immutable image launches web, worker, or migration entrypoints. Compose supplies PostgreSQL, MinIO, ClamAV, migration, web, and worker with loopback host ports and persistent volumes.

Production-mode validation requires secure auth and fail-closed scanning. Production readiness additionally needs authorization/tenancy, TLS, managed secrets/backups, retention, monitoring/alerts, and incident processes. See [Deployment](DEPLOYMENT.md), [Security](SECURITY.md), and [Limitations](LIMITATIONS.md).
