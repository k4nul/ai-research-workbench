# Deployment

## Supported local topology

The supported MVP topology is one trusted local operator, one Next.js process, one local PostgreSQL database, and a private local artifact directory.

Prerequisites:

- Node.js 22+
- npm
- Docker with Compose, or PostgreSQL 17 managed separately

```bash
cp .env.example .env
npm ci
npm run db:start
npm run db:migrate
npm run seed
npm run dev
```

The app listens on port `3100`. The Compose database maps host port `55432` to PostgreSQL `5432` and persists data in the `research-workbench-db` volume. `npm run doctor` checks Node, Docker availability, database connectivity, Playwright Chromium, storage writability, and provider-key status.

## Migrations and seed

Run migrations as an explicit release step:

```bash
npm run db:migrate
```

The migration runner creates `schema_migrations`, sorts SQL files by filename, takes PostgreSQL advisory lock `735721` inside each migration transaction, and records completed filenames. The app does not auto-migrate on startup.

Seed data is optional and synthetic:

```bash
npm run seed
```

The seed is idempotent by record ID but is intended for a local demo database. Do not seed a production database.

To clear all application rows, the reset script requires explicit opt-in and truncates the application tables:

```bash
ALLOW_DATABASE_RESET=true npm run db:reset
```

This is destructive and not a rollback mechanism. Verify `DATABASE_URL` first and require a backup if the database is not disposable.

## Container image

The multi-stage Dockerfile:

1. installs locked dependencies on Node 22 Alpine;
2. builds Next's standalone output;
3. installs Noto fonts in the runner;
4. copies only the standalone server, static files, and public assets;
5. creates `/app/.data`;
6. runs as the non-root `nextjs` user on port `3100`.

The optional Compose app profile can run the built image with the Compose database:

```bash
docker compose --profile app up --build
```

This profile forces demo mode and mounts `research-workbench-data` at `/app/.data`. It does not run migrations or seed automatically. Run those against the container database before expecting the app to be ready.

## Health and shutdown

`GET /api/health` performs `SELECT 1` and returns:

- `200` with `status: ok`, database connectivity, and demo/live configuration mode; or
- `503` with `status: degraded` when PostgreSQL is unavailable.

It is a liveness/readiness aid, not an authenticated operations endpoint and not a provider/storage check. `npm run db:stop` stops only the Compose database service; it does not delete the volume.

## Environment handling

Use the variables documented in the root README. In a nonlocal environment:

- supply `DATABASE_URL` and provider secrets from a secret manager;
- use least-privilege database credentials rather than the Compose demo password;
- mount `STORAGE_DIR` on private durable storage with backup/retention controls;
- set `PDF_FONT_PATH` to a verified font when required language coverage matters;
- keep `DEMO_MODE=true` until live egress and data-use review are complete;
- do not expose `TEST_DATABASE_URL` or destructive reset permission to the runtime.

## Verification commands

The following are commands to execute and record during a deployment; this document does not claim their outcome:

| Check | Command/evidence |
| --- | --- |
| Configuration and dependencies | `npm run doctor` |
| Migrations | `npm run db:migrate` and inspect `schema_migrations` |
| Static checks and build | `npm run lint`, `npm run typecheck`, `npm run build` |
| Automated tests | `npm test`; separately run `npm run test:e2e` |
| Health | `curl --fail http://127.0.0.1:3100/api/health` |
| Fixture workflow | `npm run seed`, then exercise the project API/UI |
| Delivery artifacts | `npm run export-demo`; open and inspect each format |
| Backup/restore | Environment-specific backup followed by a restore drill |

The configured Playwright directory is `e2e/`. Its desktop navigation/workflow and mobile-project specs use the application plus PostgreSQL, and download/parse real exports. Record the actual run result; test-file presence alone is not browser-level evidence.

## Production-readiness blockers

Do not expose the current app to untrusted users or customer data until at least these are implemented and verified:

- authenticated identities, secure sessions, authorization, approver roles, and tenant isolation;
- CSRF policy, trusted proxy configuration, distributed rate limits, quotas, and abuse handling;
- HTTPS, HSTS at the edge, managed secrets, network restrictions, database TLS, and credential rotation;
- managed PostgreSQL backups, point-in-time recovery, migration rollback/forward-fix practice, monitoring, and connection limits;
- durable private object storage, antivirus/quarantine for uploads, retention/deletion policy, and restore behavior;
- a background job/lease/retry system for provider and export workloads;
- live-provider data governance, spending limits, retry/idempotency policy, and audited smoke tests;
- broader integration/browser coverage for production identity, authorization, tenant isolation, recovery, and destructive-operation policies;
- resource limits, structured logs, metrics, traces, alerts, incident response, and dependency/container scanning;
- target-environment PDF/DOCX visual/font compatibility and continued regression coverage for formula neutralization and strict blocker enforcement.

## CI

The GitHub Actions workflow is configured for pushes to `main` and pull requests. It starts PostgreSQL, installs Node 22 dependencies, migrates, seeds, lints, typechecks, tests, builds, installs Chromium, and invokes Playwright. It uploads browser artifacts only on failure. Treat CI configuration as intent; verify that every named directory/script exists and that the workflow actually ran on the commit being handed off.
