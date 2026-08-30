# Architecture

## System shape

AI Research Workbench is a single Next.js 16 application backed by PostgreSQL. Server route handlers call typed service functions; services execute parameterized SQL and transactions; pure domain modules calculate research and QA state; export modules render delivery artifacts in process.

```text
Browser or API client
        |
        v
Next.js route handlers (app/api)
        |
        v
Services and validation (lib/services, lib/validation)
        |                    |                    |
        v                    v                    v
PostgreSQL (pg)       Pure domain rules     Export renderers
        |             (lib/domain)          (lib/export)
        |
        +---- audit events / AI run metadata / jobs / export records

Optional provider adapters: mock (default), OpenAI Responses, Brave Search
Security utilities: URL fetch, file validation, HTML sanitization
```

The diagram shows code boundaries, not an automatic pipeline. Source routes call search, safe fetch, upload validation/storage, and import services. A pipeline route invokes and persists one typed AI stage. The normal plan action applies the question-decomposition and research-plan stages, using the deterministic mock by default; the rest of the workflow does not automatically sequence all provider stages.

## Runtime components

| Component | Responsibility | Boundary |
| --- | --- | --- |
| `app/api` | HTTP parsing, validation, status/error mapping, rate-limit calls | No browser identity or session enforcement |
| `lib/services` | Transactions, state transitions, ingestion, provider-run persistence, audit records, progress refresh | PostgreSQL-specific; not a public SDK |
| `lib/domain` | Pure progress, freshness, support, citation, gap, and QA rules | No I/O and independently unit-testable |
| `lib/providers` | Typed AI/search contracts, mock implementations, optional live adapters | Selected by config and callable stage by stage; not automatically sequenced |
| `lib/security` | Untrusted-content sanitization, file validation, SSRF-resistant fetching | Used by local ingestion routes; not a substitute for auth/malware scanning |
| `lib/export` | Load project graph and render Markdown/HTML/PDF/DOCX/CSV/ZIP | In-process memory; persisted files use private storage paths |
| `lib/db.ts` | `pg` pool, query helper, transaction helper | One configured PostgreSQL database |
| `migrations` | Raw, ordered SQL schema changes | Applied by `scripts/migrate.ts` and recorded in `schema_migrations` |
| `components` and `app/**/page.tsx` | Workbench shell, reusable features, and browser workflow pages | Desktop/mobile Chromium specs are a regression baseline, not cross-browser certification |

## Request and state flow

1. A route validates JSON request bodies and selected path/query values with Zod schemas; simple identifiers and flags are parsed directly where noted by the route.
2. A service locks or queries the relevant records.
3. The service enforces the state transition and writes related records inside a transaction where consistency requires it.
4. State-changing operations append an `audit_events` record.
5. Research mutations refresh progress from persisted evidence rather than trusting the incoming status.
6. The route returns a no-store JSON response or streams an export with an attachment filename.

Expected validation/domain errors return stable application codes and bounded messages. Unexpected server failures return a generic `INTERNAL_ERROR` plus a random reference instead of exposing raw database or provider details.

## Workflow architecture

Progress is derived from eight equal gates:

```text
scope -> plan -> questions -> claim/evidence -> report -> QA -> approval -> exports
```

Material scope, research, evidence, claim, finding, or report edits invalidate downstream QA/approval state and mark persisted exports non-current. QA reads the current project graph and latest deliverable, replaces prior open engine-generated findings, records its decision, and moves the project to `QA` or `APPROVAL_REQUIRED`. Approval is an explicit request followed by a confirmed approve action. Delivery requires approval and a newly generated current ZIP.

## Data architecture

PostgreSQL holds normalized workflow entities and JSONB only where shape flexibility is useful (quality defaults, contact metadata, report sections, provider usage, audit snapshots, job payloads, and fetch/export metadata). Foreign keys and checks enforce relationships and enumerated states. See [Data model](DATA_MODEL.md).

`jobs` is currently only a durable table contract with status, attempts, schedule, and error fields. There is no job worker, lease protocol, scheduler, or retry loop. Provider and export calls therefore run synchronously when invoked.

## Provider architecture

AI work is represented as eleven typed stages. Each stage has a strict Zod output schema and metadata for provider, model, prompt-template version, input hash, timing, request ID, and usage. The mock provider produces deterministic fixtures. The OpenAI adapter sends a Responses API request with strict JSON Schema output and `store: false`; the Brave adapter performs bounded web search and normalizes results. Provider outputs containing source IDs are checked against the request allowlist.

Selection is conservative: demo mode or a missing key yields the corresponding mock provider. `POST /api/projects/:projectId/pipeline` validates source ownership, persists an `ai_runs` lifecycle, calls the selected AI adapter, and audits the result. Source search uses the selected search provider. Live provider behavior has not been verified without keys, and no orchestrator automatically sequences stages into an accepted research record. See [AI pipeline](AI_PIPELINE.md).

## Security architecture

The application assumes database records, uploads, fetched pages, and model output can contain untrusted text. Controls include schema validation, parameterized SQL, HTML sanitization, prompt-injection heuristics, citation/source allowlists, SSRF and DNS-rebinding defenses, size/time/media-type bounds, storage containment, restrictive artifact permissions, security response headers, and audit events.

These controls do not replace authentication, authorization, CSRF protection, tenant isolation, malware scanning, TLS termination, managed secrets, backups, retention, or a distributed rate limiter. See [Security](SECURITY.md).

## Deployment architecture

Development uses Node.js 22 and PostgreSQL 17 on host port `55432`. The Dockerfile builds Next's standalone output and runs it as a non-root user. Compose defines a persistent database volume and an optional `app` profile with a private data volume. Migrations are a separate operational command; the application does not auto-migrate at startup.

## Conceptual influences and licensing boundary

The architecture was informed by, but did not copy from:

- `web/web-template/templates/internal-tool-base`: composable internal-tool boundaries and caution around enabling persistence, auth, and collaboration.
- `web/google-docs-clone/Front-End`: persistent document-workspace patterns, save/review status, and sanitized document conversion.
- `automation-projects/ai-chatbot-rag`: bounded provenance, source allowlists, and untrusted retrieved text.
- `automation-projects/internal-tools-dashboard`: allowlisted operational views, dense status/detail patterns, and explicit action authorization concepts.
- `automation-projects/mvp-build-service`: intake-to-slice workflow, bounded artifacts, and strict handoff evidence.

Those repository roots have no top-level license granting source reuse. No code or assets were copied; the references were conceptual only. This repository has its own MIT license.

## Intentional decisions

- **Raw SQL over an ORM:** keeps the schema and transactional workflow explicit for the MVP.
- **Mock by default:** makes local evaluation reproducible and prevents accidental provider spend or data transfer.
- **Pure QA engine:** separates deterministic quality policy from persistence and model behavior.
- **In-process export:** minimizes infrastructure for the local MVP, at the cost of memory and request-duration limits.
- **Human approval gate:** prevents provider output or a stored status flag from authorizing final delivery.
