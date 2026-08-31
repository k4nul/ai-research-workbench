# Demo

## Purpose

The demo proves the data model and review workflow without API keys or customer data. Every fixture is synthetic and visibly labeled. Numbers, organizations, URLs, source titles, findings, and recommendations are illustrative only.

## Setup

```bash
cp .env.example .env
npm ci
npm run setup
npm run operator:create
npm run dev:all
```

`npm run setup` starts PostgreSQL, applies migrations, and seeds the fixture. Create a named operator, then `dev:all` starts the loopback web process and durable worker. Open `http://localhost:3100`, sign in, and walk through the dashboard, research, run, review, approval, operations, and export pages.

The seeded project ID is `project-demo`.

## Fixture inventory

The seed creates:

- one sample workspace and one `[SAMPLE]` client;
- one `[SAMPLE]` project dated `2026-08-15`, with a 730-day source-age limit;
- four questions and one human-approved plan per question;
- nine source records, including one explicit duplicate and one outdated source;
- twelve verified evidence records;
- twelve claims, including supported, contested, and unsupported examples; an excluded unsupported claim retains an outdated source as context only;
- fourteen claim/evidence links using support, refute, and context relationships;
- four findings and six finding/claim links;
- one version-2 report with all eleven sections;
- one report revision attributed to the mock AI actor;
- five resolved historical QA findings;
- one mock AI run and six audit events;
- one accepted small-team evidence gap.

The project starts in `APPROVAL_REQUIRED`, with approval pending. Its stored progress is a fixture value and should be refreshed/verified from gate evidence before it is used as completion proof.

## Suggested walkthrough

### 1. Establish the brief

Inspect the project and confirm the core question, scope, exclusions, research date, source-age limit, requested formats, and sample label. Review all four questions and their completion criteria. The fourth question deliberately records that the fixtures do not isolate teams with fewer than five researchers.

### 2. Review source quality

Inspect all nine sources:

- `source-demo-5` is intentionally outdated.
- `source-demo-9` has the same content hash as, and points to, `source-demo-1` as its canonical duplicate.
- publication dates and access times are distinct.
- fixture restrictions state that the data is for demonstration only.

Do not fetch the example fixture URLs and treat their pages as support for the seeded statements. The evidence is embedded synthetic content.

### 3. Trace evidence and claims

Follow `claim-demo-2`. `evidence-demo-2` supports an 18% post-onboarding improvement while `evidence-demo-12` refutes an unconditional immediate-gain interpretation with a 7% first-month decline. The claim is `CONTESTED`; its resolution notes explain the time-horizon distinction.

Review `claim-demo-12`, an unsupported universal-gain statement excluded from the report, and `claim-demo-11`, which has only an outdated `CONTEXT` link, is unsupported, and is also excluded from the report.

### 4. Inspect report provenance

Open the latest deliverable and locate bracketed source IDs in detailed analysis. Confirm that citations refer to existing source IDs and that the references/limitations disclose the duplicate, outdated evidence, synthetic status, and accepted gap.

### 5. Run QA

Use the QA page to run QA and record the actual findings. The authenticated mutation supplies same-origin and CSRF proof. The seeded historical findings demonstrate earlier corrections; a fresh QA run evaluates the current graph and may replace only open engine-generated findings. Do not assume the seed's `qa_passed_at` proves the rerun outcome.

### 6. Review approval

The project is seeded with approval pending. Use the Approval page and its explicit confirmation. This mutates the local fixture and records the authenticated operator derived from the durable session. v0.2 does not have a separate approver role or cryptographic signature.

### 7. Exercise durable operations

Start a disposable mock run from the Runs workflow, then inspect its eleven stage generations, jobs, attempts, provider executions, metrics, and audit events. The deterministic provider requires no key. If you stop the worker, queued work remains durable; restart it with `npm run worker`. Do not treat a completed mock run as factual research evidence.

### 8. Inspect exports

Before approval, generate review formats:

```bash
npm run export-demo
```

After an intentional approval transition, generate the ZIP:

```bash
npm run export-demo -- --approve
```

Open every report format and inspect every ZIP entry following [Export formats](EXPORT_FORMATS.md). Verify sample labels and compare ledger/source/QA records with the API.

## Resetting the fixture

Reset truncates all application data in the configured database and requires an explicit safety flag:

```bash
ALLOW_DATABASE_RESET=true npm run db:reset
npm run seed
```

Verify `DATABASE_URL` before running it. This operation has no undo beyond restoring a database backup.

## Screenshot handoff

The final documentation expects at least:

```text
docs/screenshots/dashboard.png
docs/screenshots/project-overview.png
```

Generate captures only after PostgreSQL is seeded and the application is running at `APP_URL`:

```bash
npm run screenshots
```

`scripts/capture-screenshots.ts` launches Chromium at 1440×1000, verifies the dashboard and seeded project headings/links, and writes both files. Record the command result; a manually created image is not a substitute for browser interaction tests.

Screenshots must show sample labeling and must not contain `.env` values, provider keys, local usernames, unrelated browser UI, or real customer data.
