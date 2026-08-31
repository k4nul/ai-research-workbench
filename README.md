# AI Research Workbench

AI Research Workbench v0.2.0 is a local, evidence-first workspace that turns a scoped research brief into a reviewable, approval-gated delivery package. It preserves the source → evidence → claim → finding → deliverable graph, runs deterministic QA, records named operator actions, and can execute an eleven-stage research pipeline through a durable PostgreSQL worker.

The default provider path is deterministic and does not require API keys. The application is suitable for local evaluation and controlled internal development; its authentication is deliberately minimal and is not a multi-tenant authorization boundary.

## Implemented workflow

1. Create a project, scope, questions, and an approved research plan.
2. Register manual, searched, fetched, imported, reused, or uploaded sources.
3. Quarantine uploaded PDF, DOCX, TXT, HTML, Markdown, CSV, or JSON documents, scan them, and extract bounded text, blocks, chunks, and citation anchors.
4. Start a versioned research run. The worker executes intake, decomposition, planning, source summarization, evidence extraction, claim generation, gap detection, conflict detection, outlining, drafting, and QA revision.
5. Review generated records; model output never grants approval authority.
6. Resolve deterministic QA blockers, request approval, and record a human decision.
7. Generate Markdown, HTML, PDF, DOCX, CSV, or an approval-gated ZIP. Persisted artifacts are integrity-checked in private local or S3-compatible object storage.

The queue provides **at-least-once delivery, not exactly-once execution**. Job input hashes, idempotency keys, run-stage generations, domain-commit records, and worker fences prevent known duplicate or stale commits, but every new handler must still make its external and domain effects replay-safe.

## Quick start

Prerequisites are Node.js 22.13 or newer, npm, and Docker with Compose (or a separately managed PostgreSQL 17 instance).

```bash
cp .env.example .env
npm ci
npm run setup
npm run operator:create
npm run dev:all
```

Open `http://localhost:3100`, sign in with the operator you created, and select the synthetic `project-demo` fixture. `npm run dev:all` starts both the loopback-bound Next.js development server and the worker; `npm run dev` starts only the web process.

For the complete container topology (PostgreSQL, private MinIO bucket, ClamAV, migration job, web, and worker):

```bash
docker compose up -d --build --wait
docker compose exec -T web ./node_modules/.bin/tsx scripts/seed.ts
docker compose ps
```

The supplied ports are bound to loopback. The Compose configuration uses secure auth cookies; interactive HTTP-only evaluation normally uses the host development setup above. Do not weaken cookie security on a remotely reachable deployment.

## Demo and live providers

`npm run seed` creates visibly synthetic evidence, claims, findings, revisions, QA history, and audit events. `DEMO_MODE=true` or absent provider credentials selects deterministic mock AI and search adapters. Mock mode exercises orchestration and persistence, but it is not evidence of live-provider compatibility or research accuracy.

With `DEMO_MODE=false`, `OPENAI_API_KEY` enables the OpenAI Responses adapter and `BRAVE_SEARCH_API_KEY` enables Brave Search. Live calls are optional, incur external data transfer and cost, and are never part of normal tests. Use the bounded compatibility canary explicitly:

```bash
npm run test:providers:live
```

The canary records `PASSED`, `FAILED`, or `NOT_RUN_NO_CREDENTIALS`; it does not assign an accuracy score. `npm run eval:mock` runs the labeled deterministic evaluation corpus. `npm run eval:live` intentionally reports that accuracy scoring is not applicable and directs operators to the canary.

## Operations and safety

- Use the Jobs, Runs, Operations, Documents, Evaluations, Sessions, and Audit screens to inspect durable state and operator actions.
- `GET /api/health` is public and checks configuration, PostgreSQL, and object-storage reachability. Authenticated `GET /api/metrics` exposes aggregate operational counters; worker readiness is available through `GET /api/workers/readiness` or `npm run worker:readiness` with `WORKER_ID` set.
- Cancellation is cooperative. Queued work cancels immediately; claimed or running work moves to `CANCELLATION_REQUESTED` until the worker observes it or its lease expires.
- Retryable failures use bounded exponential backoff with jitter and honor a larger provider `Retry-After`. Exhausted retryable work becomes `DEAD_LETTER`; non-retryable work becomes `FAILED`.
- Manual retry is available only for failed/dead-letter non-pipeline jobs. Restart a pipeline stage through the run-stage action so a new generation is created and downstream generations are marked stale.
- Production configuration requires authentication, secure cookies, a 32+ character session secret, fail-closed ClamAV, and no demo bypass. These checks still do not provide roles, tenant isolation, TLS termination, backup policy, or retention governance.

See [Operations](docs/OPERATIONS.md), [Document pipeline](docs/DOCUMENT_PIPELINE.md), [Authentication](docs/AUTHENTICATION.md), and [Security](docs/SECURITY.md) before handling non-synthetic data.

## Configuration

[`.env.example`](.env.example) is the canonical variable inventory. Important groups are:

| Group | Variables | Notes |
| --- | --- | --- |
| Runtime | `DATABASE_URL`, `DATABASE_POOL_SIZE`, `APP_URL`, `APP_BIND_HOST`, `DEMO_MODE` | Demo auth bypass additionally requires loopback URL and bind host. |
| Worker | `WORKER_CONCURRENCY`, `WORKER_POLL_INTERVAL_MS`, `JOB_*`, `DOCUMENT_EXTRACTION_CONCURRENCY` | Lease duration must exceed twice the heartbeat interval. |
| Providers | `OPENAI_*`, `BRAVE_SEARCH_API_KEY`, `PROVIDER_*`, `MODEL_PRICING_JSON` | Unknown live model cost stays `UNKNOWN`; it is never silently treated as zero. |
| Ingestion | `MAX_UPLOAD_BYTES`, `MAX_FETCH_BYTES`, `FETCH_TIMEOUT_MS` | Defaults are 5 MiB upload, 2 MiB fetch, and 10 seconds. |
| Storage | `STORAGE_PROVIDER`, `STORAGE_DIR`, `STORAGE_MAX_OBJECT_BYTES`, `S3_*` | Local storage uses contained `0700` directories and `0600` files; S3 uses a private configured bucket. |
| Scanning | `MALWARE_SCANNER_PROVIDER`, `CLAMAV_*`, `MALWARE_*` | The mock scanner is a local test fixture, not a security control. |
| Authentication | `AUTH_ENABLED`, `AUTH_SESSION_SECRET`, `AUTH_SESSION_TTL_SECONDS`, `AUTH_COOKIE_SECURE`, `AUTH_DEMO_BYPASS`, `AUTH_LOGIN_*` | Authentication is required in production; bypass is forbidden there. |

Never commit `.env`, provider credentials, customer research, private URLs, runtime storage, evaluation artifacts, or delivery bundles.

## Verification

Run the narrow lane that matches the change, then the applicable full gate. A configured command or existing test file is not proof that it passed in the current checkout.

```bash
npm run docs:validate
npm run test:unit
npm run test:integration
npm run test:workers
npm run test:documents
npm run test:providers
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm run verify
```

`npm run verify` runs lint, typecheck, documentation metadata validation, the complete Vitest suite, and a production build; it does not run Playwright. Database tests require `TEST_DATABASE_URL`, and the preparation script refuses database names that do not contain `test`. Browser tests run authenticated desktop Chromium, iPhone 13 emulation, and an unauthenticated auth project. See [Testing](docs/TESTING.md) for lane scope and current gaps.

Release evidence is generated only after migration, seed, and mock evaluation. Release automation deliberately leaves the synthetic fixture unapproved and builds a separately labeled preview ZIP for format verification without creating a persisted final project export; it never records or claims a human decision:

```bash
npm run eval:mock
npm run release:prepare
npm run release:verify
```

Release verification rejects missing or extra assets, requires one checksum for every expected asset, and checks that the sample bundle says `releasePreview: true`, `finalDelivery: false`, and `humanApprovalRecorded: false`. Before creating the version tag, enable GitHub immutable releases and an exact-version tag ruleset that blocks update and deletion but permits initial creation. The tagged workflow refuses to overwrite an existing release, rechecks that the remote tag still resolves to the exact CI-approved commit before draft creation and publication, then verifies GitHub's immutable-release attestation and every published asset.

## Migration and rollback

Upgrade from v0.1 by backing up the database and private artifacts, installing v0.2, and running `npm run db:migrate`. Migrations are ordered, checksum-verified, transactional, advisory-lock protected, and **forward-only**. There are no down migrations. If a migration has committed, rollback means restoring the pre-upgrade database and matching object-store snapshot, or deploying a reviewed forward-fix migration; never edit an applied migration. Follow [Migrating from v0.1](docs/MIGRATING_FROM_V0_1.md).

## Known boundary

v0.2 provides named operators, durable sessions, CSRF protection, worker leases, object storage, ClamAV integration, deterministic evaluation, and operations views. It does not provide roles or approver permissions, tenant/workspace authorization, MFA/SSO/recovery, public signup, managed TLS or secrets, automated backup/restore, retention/legal hold enforcement, tamper-evident audit export, distributed HTTP rate limiting, OCR, image extraction, arbitrary file conversion, or exactly-once execution. Prompt-injection detection is heuristic and only raises review signals.

See [Limitations](docs/LIMITATIONS.md) and [Roadmap](docs/ROADMAP.md) for the explicit non-production boundary.

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Research workflow](docs/RESEARCH_WORKFLOW.md)
- [AI pipeline](docs/AI_PIPELINE.md)
- [Operations](docs/OPERATIONS.md)
- [Document pipeline](docs/DOCUMENT_PIPELINE.md)
- [Providers, evaluation, and budgets](docs/PROVIDERS_EVALUATION.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Export formats](docs/EXPORT_FORMATS.md)
- [QA rules](docs/QA_RULES.md)
- [Demo](docs/DEMO.md)
- [Migration from v0.1](docs/MIGRATING_FROM_V0_1.md)
- [Limitations](docs/LIMITATIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Management metadata](docs/management/INDEX.json)
- [Changelog](CHANGELOG.md)

The project is distributed under the [MIT license](LICENSE).
