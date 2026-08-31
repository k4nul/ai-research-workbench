# Testing and verification

## Evidence policy

Use executable behavior as release evidence. A file, route, checked box, management status, screenshot, or configured command is not a passing result. Record the command, commit/worktree under test, environment, result, and any skipped lane.

Normal automated tests must not require provider keys or live network access. Database tests use `TEST_DATABASE_URL`; the preparation script refuses a database name that does not contain `test`.

## Test lanes

| Lane | Command | Scope |
| --- | --- | --- |
| Documentation metadata | `npm run docs:validate` | Strict JSON schemas, unique IDs, complete package commands/workflows/doc index, declared route exports, filesystem paths, and local Markdown links |
| Unit | `npm run test:unit` | Pure domain rules, auth/security primitives, job transitions/backoff, budgets, storage/extractors, evaluation logic |
| Full Vitest | `npm test` | Prepares the test database and runs unit, contract, and integration specs |
| Integration | `npm run test:integration` | PostgreSQL workflow, auth, runs, jobs, documents, operations, evaluation, export persistence, migrations |
| Workers | `npm run test:workers` | Durable execution unit/integration and operational services |
| Documents | `npm run test:documents` | Local/S3 storage, ClamAV, scan/extract worker flow, targeted cleanup/retry, security limits |
| Provider contracts | `npm run test:providers` | Mocked fetch, schemas, source allowlists, optional adapter contracts |
| Optional live canary | `npm run test:providers:live` | Bounded synthetic OpenAI/Brave compatibility; external and billable |
| Mock evaluation | `npm run eval:mock` | Ten labeled fixtures through durable PostgreSQL orchestration |
| Types | `npm run typecheck` | TypeScript no-emit check |
| Lint | `npm run lint` | ESLint repository check |
| Build | `npm run build` | Next.js production bundle |
| Browser | `npm run test:e2e` | Authenticated desktop, mobile emulation, and unauthenticated auth flows |
| Main gate | `npm run verify` | Lint, types, documentation metadata, full Vitest, build; excludes Playwright |
| Secret hygiene | `npm run validate:secrets` | Tracked/untracked candidate paths and common credential patterns |
| Release artifact | `npm run release:verify` | Exact asset/checksum allowlists and structural parsing of release JSON/PDF/DOCX/ZIP |

Run the narrowest relevant lane first. Security, auth, storage, provider, migration, and queue changes require negative cases. UI behavior requires Playwright or equivalent browser interaction; component existence is insufficient.

## Browser coverage

Playwright uses one worker and three projects:

- `chromium`: authenticated Desktop Chrome storage state; all specs except auth;
- `mobile`: authenticated iPhone 13 emulation; `mobile.spec.ts`;
- `auth`: unauthenticated Desktop Chrome; `auth.spec.ts`.

The browser command prepares `TEST_DATABASE_URL`, and Playwright refuses to start unless its database name contains `test`. The config points every browser process, standalone server, and helper child process at that same URL. Global setup resets only that guarded test database, reseeds the synthetic sample, creates isolated synthetic operators and a durable session, then writes temporary browser storage state under `.artifacts`. Global teardown removes that state and fixture identities. Playwright builds the Next.js standalone production output, copies `public` and `.next/static` into it as required by Next.js, and starts it on a private loopback backend port. An HTTPS loopback proxy presents `https://127.0.0.1:3100` with an ephemeral self-signed certificate, secure cookies, authentication bypass disabled, and production fail-closed ClamAV configuration. The certificate and private key live only in an operating-system temporary directory and are removed when the harness exits.

Current specs cover:

- login denial/success, protected redirects, password change, logout, and session revocation;
- main navigation and project surfaces;
- intake-to-approval workflow, provenance links, report revisions, QA, exports, and stale delivery denial;
- operations metrics/worker-readiness visibility, job cancel/retry, run resume, and Documents/Evaluations/provider-history page reachability where encoded in `operations.spec.ts`;
- mobile navigation/control reachability and absence of unintended horizontal overflow for encoded surfaces.

This is Chromium-only regression evidence. It is not exhaustive keyboard or screen-reader certification, a full WCAG audit, cross-browser coverage, visual regression, proof of the target deployment's external TLS/reverse-proxy configuration, load testing, chaos testing, or a live-provider accuracy evaluation.

## Database and service setup

Host workflow:

```bash
npm run db:start
npm run db:migrate
npm run seed
npm run doctor
```

Test workflow:

```bash
export TEST_DATABASE_URL=postgresql://research:research@localhost:55432/research_workbench_test
npm run test:prepare
npm run test:integration
```

The test preparation command creates/recreates only a database whose name contains `test`. `ALLOW_DATABASE_RESET=true npm run db:reset` is destructive and is not a substitute for test preparation; inspect `DATABASE_URL` first and use it only for a confirmed disposable database.

The document-security lane needs S3-compatible object storage and ClamAV when `REQUIRE_S3_TEST=true` and `REQUIRE_CLAMAV_TEST=true`. The configured CI lane starts those Compose services. Without the requirement flags, environment-dependent integration cases can be skipped; report that explicitly rather than calling the entire security boundary verified.

## CI and release evidence

`.github/workflows/ci.yml` separates quality, database integration, document security, provider contracts, deterministic evaluation, browser E2E, and production-container jobs. Container verification builds the same immutable web/worker image, checks the non-root user, starts the full topology, verifies worker readiness, seeds, and runs all eleven mock stages.

`.github/workflows/live-canary.yml` is optional and separated from required CI. `.github/workflows/release.yml` requires successful mandatory CI on the exact v0.2.0 tag commit and refuses to overwrite any existing release for that tag. For a new tag release it regenerates evidence from the still-unapproved synthetic fixture, creates a clearly marked non-final preview ZIP without persisting a final project export or claiming human approval, requires the exact asset/checksum sets, creates a draft, redownloads and verifies it, and only then publishes. GitHub immutable releases and an exact-tag update/deletion ruleset must be enabled first; the workflow rechecks the remote tag before draft creation and publication, then verifies the immutable-release attestation and each published asset.

The presence of these workflows documents intended automation. Only a successful run on the exact revision is evidence.

## Artifact inspection

Automated export/release tests parse PDF pages, DOCX ZIP entries and `word/document.xml`, the exact delivery ZIP inventory, unapproved-preview metadata, JSON schemas, and SHA-256 manifests. Also inspect representative PDF and DOCX files in target viewers, fonts/languages, page breaks, tables, and formula-neutralized CSV behavior before a production-like release. Structural validity is not visual fidelity or office-suite compatibility.

## Troubleshooting

### Database tests refuse to run

Set `TEST_DATABASE_URL` to a reachable PostgreSQL database whose database name contains `test`. Do not point it at the development or production database. Confirm PostgreSQL is ready and rerun `npm run test:prepare`.

### Playwright cannot find Chromium

```bash
npx playwright install chromium
```

On Linux CI/container hosts, `npx playwright install --with-deps chromium` also installs system dependencies.

The browser harness also requires `openssl` to generate a one-run loopback certificate. No key or certificate is written into the repository. Playwright ignores certificate trust errors only for this isolated self-signed test origin.

### Browser tests redirect to login

Do not reuse an existing development server. Playwright owns the production standalone server and HTTPS loopback proxy, sets `AUTH_DEMO_BYPASS=false`, requires `AUTH_COOKIE_SECURE=true`, and creates its own operators/session. Confirm ports 3100 and 3101 are free. Remove stale `.artifacts/e2e-auth-storage.json` only after confirming no test is running, then rerun.

### Worker tests time out

Check lease duration versus heartbeat, PostgreSQL clock/connectivity, and leftover worker processes. A test should use isolated job IDs and wait for durable state, not a fixed sleep. Inspect job attempts/events before increasing timeouts.

### Document tests skip S3 or ClamAV

Start `object-storage`, `object-storage-init`, and `scanner` with Compose, set the matching endpoint/credentials/host, and set the requirement flags. A skipped integration is not a pass for the external adapter.

### Typecheck and lint disagree with a focused test

Focused Vitest transpilation does not guarantee repository type/lint validity. Run `npm run typecheck` and `npm run lint` after the focused lane. Review concurrent worktree changes before attributing a failure.

### Live canary reports not run

That is the expected result without credentials. Do not add secrets to fixtures or required CI. If a live check is authorized, inject secrets through the approved secret store and run the explicit canary; record provider cost and data-transfer approval.
