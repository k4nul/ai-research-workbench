# Deployment

## Supported local topologies

### Host development

PostgreSQL runs in Compose; web/worker run on the host with local object storage and the mock scanner/provider defaults:

```bash
cp .env.example .env
npm ci
npm run setup
npm run operator:create
npm run dev:all
```

`npm run dev` binds Next.js to `127.0.0.1:3100`; `npm run worker` runs only the worker. `dev:all` manages both child processes.

### Full Compose

```bash
docker compose up -d --build --wait
docker compose exec -T web ./node_modules/.bin/tsx scripts/seed.ts
docker compose ps
docker compose exec -T worker ./node_modules/.bin/tsx scripts/worker-readiness.ts
```

Services are PostgreSQL 17, MinIO, bucket initialization, ClamAV 1.4.6, one-shot migration, web, and worker. Published ports for web, database, MinIO, console, and scanner are loopback-only. Persistent volumes hold PostgreSQL, objects, ClamAV signatures, and application data.

The Compose auth cookie is secure while the published development origin is HTTP. Health/API automation works, but an interactive browser will not send secure cookies over plain HTTP. For browser evaluation use the host development topology, or put Compose behind a trusted HTTPS origin; do not make cookies insecure on a remotely reachable host.

## Image

The multi-stage Dockerfile:

1. installs locked build dependencies and a separate production-only dependency tree on Node 22 Alpine;
2. builds Next.js standalone output;
3. installs Noto and Noto CJK fonts plus `tini`;
4. copies the standalone web server plus shared `lib`, `worker`, `scripts`, and `migrations`;
5. creates private application data;
6. runs as non-root UID/GID 1001;
7. exposes the web entrypoint by default; Compose overrides the command for migration/worker.

The runtime image installs with `npm ci --omit=dev` and then removes Next.js's development-only optional Playwright peer packages. It excludes Playwright, Vitest, ESLint, TypeScript, and other development-only packages, while runtime CLI commands retain `tsx` and `dotenv` as direct production dependencies. The dependency audit uses `--omit=dev` so every direct and transitive production dependency remains covered.

Web and worker must use a compatible image, schema, pipeline/prompts, and job contracts. Rolling mismatched versions is not supported.

## Configuration gates

[`.env.example`](../.env.example) is canonical. Startup validation includes:

- Node.js 22.13+ at package level;
- lease duration greater than twice heartbeat;
- S3 endpoint/access key/secret when S3 is selected;
- loopback URL for auth bypass;
- in production: auth enabled, bypass disabled, secure cookies, 32+ session secret;
- in production: ClamAV selected, malware required, scanner bypass disabled.

The web health route validates auth runtime and probes PostgreSQL/object storage. The worker readiness command additionally checks the worker heartbeat/status, queue table, storage, scanner, and selected provider configuration.

Production gates reject unsafe configuration, but they do not install TLS, secrets, IAM, backups, authorization, retention, monitoring, or incident response.

## Migrations

Run migrations as a separate deployment step before starting a new web/worker version:

```bash
npm run db:migrate
```

The runner serializes with an advisory lock, checks applied-file SHA-256, and applies each new file in a transaction. It is safe and expected to run twice. Migrations are forward-only. Back up PostgreSQL and object storage together; after a commit, recover by restoring the matching snapshots or deploying a forward fix. See [Migrating from v0.1](MIGRATING_FROM_V0_1.md).

Do not run `db:reset` in deployment. It requires `ALLOW_DATABASE_RESET=true` because it truncates application state.

## Health and readiness

| Probe | Meaning | Does not prove |
| --- | --- | --- |
| `GET /api/health` | Auth configuration parsed; PostgreSQL and object storage responded | worker, scanner, provider, migration currency, end-to-end run |
| `GET /api/workers/readiness?workerId=...` | Stored worker heartbeat is current and READY | scanner/storage/provider dependencies |
| `WORKER_ID=... npm run worker:readiness` | Worker, queue, storage, scanner, and selected providers are usable | research quality, external SLA |
| `npm run doctor` | Local Node/Docker/DB/schema/browser/storage/config diagnostics | production security or load readiness |

Health responses use no-store. Set process/container timeouts so the worker's graceful stop period fits inside the platform termination window.

## Worker rollout and recovery

Stop old workers from claiming, allow them to drain, and wait for active leases or the shutdown grace period before replacing the image. The worker marks `DRAINING`, aborts remaining handlers after grace, and releases leases. A healthy worker recovers expired work.

The queue is at least once, not exactly once. Do not roll out a handler that is incompatible with already queued input or stored stage schema. If compatibility must change, version the job/stage contract and provide reconciliation.

## Object storage and scanner

For S3-compatible storage:

- create a private bucket before web/worker start;
- use least-privilege credentials and network policy;
- configure encryption, backup/versioning, lifecycle, retention/legal hold, and restore;
- keep signed URL TTL short and verify application origin/referrer behavior;
- monitor catalog-versus-object integrity and orphan cleanup.

For ClamAV:

- persist and update signatures;
- monitor daemon readiness/version/database age;
- size memory for whole-object buffering plus scanning;
- keep the fail-closed policy;
- treat mock or bypassed scans as non-production evidence.

## Observability

Collect JSON-line stdout/stderr from web/worker/CLI, protect it as potentially sensitive, and retain job/run/provider/document identifiers for correlation. Poll or adapt authenticated `/api/metrics` and worker endpoints into the deployment's metrics/alert system.

At minimum alert on:

- no READY worker or stale heartbeat;
- increasing queue depth/oldest age;
- dead-letter or repeated retry growth;
- provider failure/unknown-cost/budget blocks;
- scanner/storage failures and infected documents;
- run-stage failures/blocks;
- QA blockers and export persistence failures;
- migration/checksum failure.

The repository supplies aggregates and logs, not Prometheus/OpenTelemetry exporters, dashboards, SLOs, alerts, or an external audit sink.

## Verification

Record results for the exact deployable revision:

```bash
npm run docs:validate
npm run validate:secrets
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run eval:mock
npm run release:verify
```

Also validate `docker compose config --quiet`, build web/worker/migrate, verify the non-root UID, start the full environment, probe worker readiness, seed the synthetic fixture, and run `npm run smoke:research-run` in the container. CI configuration is intent; require its actual successful run on the same commit.

Before creating a release tag, enable GitHub immutable releases for the repository. Add an active ruleset for that exact version tag which blocks update and deletion, has no bypass actors, and does not block initial creation; do not apply this lock to a moving major/minor tag. The release workflow uses read-only checkout credentials, grants write permission only to its publish job, and re-resolves the remote tag immediately before draft creation and publication. After publication it verifies GitHub's release attestation and each local asset against the immutable release. Drafts remain editable until publication so every asset and checksum can be redownloaded and checked first.

## Production-readiness checklist

Before exposure to untrusted users or customer data:

- implement and test authorization roles and tenant isolation;
- terminate TLS/HSTS and configure trusted proxy/origin/client address behavior;
- use managed secrets, least-privilege database/storage credentials, database TLS, and egress restrictions;
- add managed backups/PITR and restore drills for PostgreSQL plus object storage;
- define retention, deletion, legal hold, audit/log access, and incident response;
- deploy distributed abuse/rate controls and provider spend/billing reconciliation;
- add metrics/tracing exporters, SLOs, alerts, capacity tests, and failure exercises;
- complete accessibility/cross-browser and target PDF/DOCX compatibility evidence;
- document vulnerability/dependency/container/infrastructure management.

Until then, keep the application loopback/private and follow [Limitations](LIMITATIONS.md).
