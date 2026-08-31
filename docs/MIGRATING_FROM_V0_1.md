# Migrating from v0.1

## Scope

This guide upgrades a v0.1 PostgreSQL database and private artifact directory to v0.2.0. v0.2 adds durable run/stage execution, leases and attempts, document/object-storage catalogs, operator authentication, HTTP mutation receipts, worker/provider/evaluation operations, migration checksums, and integrity-aware export persistence.

Migrations are **forward-only**. The repository has no down migrations and does not support running v0.1 code against a database after v0.2 schema changes have committed.

## Before the upgrade

1. Stop every v0.1 web process and any ad hoc scripts that mutate the database.
2. Record the exact v0.1 commit/package version, Node version, PostgreSQL version, `DATABASE_URL` target, and artifact storage location.
3. Create a consistent PostgreSQL backup and verify it can be listed/read.
4. Snapshot the entire v0.1 private `STORAGE_DIR`, including persisted exports/uploads. Database metadata and object bytes are one recovery unit.
5. Copy `.env` through an approved secret channel; do not commit it.
6. Provision a v0.2 `AUTH_SESSION_SECRET` of at least 32 random characters and decide the operator bootstrap username.
7. If using the full topology, provision the private S3/MinIO bucket and ClamAV signature volume. Do not enable S3 until endpoint and credentials are present.
8. Rehearse the upgrade against restored copies before the production-like maintenance window.

Do not use `db:reset`. It is destructive and is not a migration tool.

## Upgrade

Install the release with Node.js 22.13 or newer:

```bash
npm ci
npm run db:migrate
npm run db:migrate
npm run operator:create
npm run doctor
```

The second migration run is an explicit idempotency check. The runner:

- sorts `migrations/*.sql` by filename;
- takes a PostgreSQL advisory lock so only one runner applies changes;
- wraps each unapplied migration in its own transaction;
- records the filename, timestamp, and SHA-256 checksum in `schema_migrations`;
- rejects an applied file whose current contents differ from the recorded checksum;
- rejects a database containing a migration absent from the running image, preventing downgrade startup;
- backfills checksums for legacy migration records that predate checksum support.

Never modify, rename, reorder, or delete an applied migration. Add a new forward-fix migration for any correction.

## Data compatibility notes

- Existing scope and plan approvals are represented as legacy revision snapshots so new runs can freeze an explicit revision.
- Existing job rows receive legacy idempotency/input identifiers and remain history. A v0.1 row does not imply that v0.2 executed it.
- Existing source/upload metadata is cataloged under generated legacy storage-object records. Metadata does not move or validate bytes.
- Existing persisted exports receive storage catalog links. Because migration SQL cannot safely read arbitrary historical files, legacy export objects are marked for byte-level verification rather than trusted as verified. Regenerate the current artifact through v0.2 whenever possible.
- Existing project IDs remain text identifiers; legacy non-UUID IDs such as `project-demo` remain supported by project routes. New operation/run/job identifiers retain their stricter route schemas where applicable.
- Existing pipeline-generated evidence, claims, and AI QA suggestions with the established deterministic ID prefixes are linked to their generating run stage. Forward-fix migrations also link legacy `ai-conflict-*` QA rows and reconcile generated evidence, claims, findings, and QA findings so only the latest successfully committed, non-stale stage for each project/stage remains current. Manual rows remain current.
- Research-gap provenance is available for new pipeline gap commits. Existing question gap decisions are preserved as manual state, and later stage reruns never clear `ACCEPTED` or `RESOLVED` human decisions.
- New operator/session tables start empty. Seeding research data does not create an operator; bootstrap one explicitly.
- `017_mutation_receipts.sql` adds durable principal/method/path/key receipts for bounded HTTP mutation responses. `018_mutation_receipt_error_responses.sql` permits intentional replayable auth 4xx results; both are additive and contain no v0.1 backfill. After upgrade, API/browser mutation clients must supply `Idempotency-Key` and retain it when retrying the same input.
- New worker, provider execution/permit, canary, evaluation, and run-stage histories start empty except for records produced after v0.2 actions.
- v0.2 storage can be local or S3-compatible. A catalog row that points at a legacy local path is not automatically uploaded to S3.

## Start and verify

Host development:

```bash
npm run seed
npm run dev:all
```

Full container topology:

```bash
docker compose up -d --build --wait
docker compose ps
docker compose exec -T worker ./node_modules/.bin/tsx scripts/worker-readiness.ts
```

Then verify:

1. Sign in with the new operator and list active sessions.
2. Open representative legacy projects, sources, claims, reports, QA, approval, audit, and exports.
3. Confirm old project IDs resolve and project-scoped routes reject records from another project.
4. Submit a disposable mock run and confirm all eleven stages finish once through the durable worker.
5. Upload a synthetic document, verify quarantine → clean scan → extraction, and inspect anchors. Do not use the mock scanner as production evidence.
6. Submit durable export POST jobs for fresh non-final formats and, for an approved synthetic project, a current ZIP; use the GET endpoint only to download without persistence.
7. Inspect `/operations`, `/jobs`, `/runs`, `/documents`, `/evaluations`, and `/audit`.
8. Run the applicable automated gates and record actual results.

```bash
npm run docs:validate
npm run test:unit
npm run test:integration
npm run test:e2e
npm run typecheck
npm run lint
npm run build
```

## Forward-only rollback procedure

### Before any v0.2 migration commits

If installation or connection validation fails before a schema migration commits, fix the environment or redeploy v0.1; the database is unchanged. Confirm `schema_migrations` before making that claim.

### After any v0.2 migration commits

Do not run v0.1 against the upgraded database and do not attempt hand-written reverse SQL.

Choose one of these reviewed recovery paths:

1. **Restore:** stop v0.2 web and workers; create a forensic snapshot of the failed upgraded state; restore the pre-upgrade PostgreSQL backup into a clean database; restore the matching pre-upgrade artifact/object snapshot; point v0.1 at both restored stores; verify referential/artifact integrity before reopening traffic.
2. **Forward fix:** keep v0.2 stopped or read-only; add a new ordered migration and any compatible code fix; test it against a copy of the failed state; deploy it forward; rerun migration and verification.

Database and object storage must be restored to the same point. Restoring only PostgreSQL can leave missing/new objects; restoring only objects can leave metadata that does not match bytes. Provider calls, external deliveries, emails, or downloads that occurred after the backup cannot be rolled back by database restore and need explicit reconciliation.

## Failed migration recovery

An error inside one migration rolls back that migration's transaction, while earlier migrations remain committed. Preserve the error and `schema_migrations` state. Correct prerequisites or ship a forward fix; rerun `npm run db:migrate`. The advisory lock is session-scoped and is released when the runner exits.

If checksum validation fails, treat it as evidence that an applied migration file changed. Restore the canonical release file or investigate repository integrity. Do not update the stored checksum to silence the error.

## Post-upgrade limitations

The upgrade does not create roles, tenant isolation, MFA/SSO, automated backup/restore, retention/legal hold, OCR, exactly-once job execution, or a migration rollback engine. Read [Authentication](AUTHENTICATION.md), [Operations](OPERATIONS.md), [Document pipeline](DOCUMENT_PIPELINE.md), and [Limitations](LIMITATIONS.md) before production-like use.
