# Data model

## Storage and migrations

The application uses PostgreSQL through `pg`. `migrations/001_initial.sql` is the initial raw schema; `002_current_exports.sql` adds current/stale export state, conservatively marks pre-existing rows stale, and defaults new rows current; `003_claim_support_metadata.sql` adds evidence support extent and claim verification possibility; and `004_claim_scope.sql` adds explicit claim scope classification. `scripts/migrate.ts` applies ordered `.sql` files and records each filename in `schema_migrations`; it is not an ORM migration system. Schema changes should be additive migrations rather than edits that make an already-applied migration ambiguous.

## Research graph

The central provenance chain is:

```text
workspace
  +-- clients
  +-- research_projects
        +-- research_questions -- research_plans
        +-- sources -- evidence -- claim_evidence -- claims
        |                                      +-- finding_claims -- findings
        +-- deliverables -- deliverable_revisions
        +-- qa_findings
        +-- audit_events
        +-- ai_runs
        +-- jobs
        +-- project_exports
```

`claim_evidence` records whether evidence supports, refutes, or only contextualizes a claim. `finding_claims` records which claims justify a finding. Report sections and references are stored on a versioned deliverable; exported files are derived from the current graph.

## Entity catalog

| Table | Purpose | Important invariants |
| --- | --- | --- |
| `workspaces` | Research defaults and top-level grouping | Language, citation style, and quality defaults are metadata, not access control |
| `clients` | Optional client context | Security classification is descriptive; no authorization middleware consumes it |
| `research_projects` | Brief, scope, research date, max source age, workflow and approval state | Progress is 0–100; project state and approval values are checked |
| `research_questions` | Decomposed questions and gaps | Gap is `NONE`, `OPEN`, `ACCEPTED`, or `RESOLVED` |
| `research_plans` | One plan per question | Unique `question_id`; AI suggestion and human approval are separate flags |
| `sources` | Source provenance, content state, reuse, freshness, duplicate, fetch/upload metadata | Source belongs to one project; duplicate/reuse links are explicit |
| `evidence` | Minimal summary/quote/location extracted from a source | Verification is `PENDING`, `VERIFIED`, or `REJECTED`; support extent is `FULL` or `PARTIAL` |
| `claims` | Atomic factual, interpretive, inferential, or recommendation statements | Support, fact/inference, verification possibility, scope, and report inclusion are separate fields |
| `claim_evidence` | Many-to-many claim/evidence relationship | Composite primary key; relationship is `SUPPORTS`, `REFUTES`, or `CONTEXT` |
| `findings` | Synthesized project conclusions | May be linked to questions and recommendation suitability |
| `finding_claims` | Many-to-many finding/claim links | Composite primary key |
| `deliverables` | Versioned report title and eleven-section JSONB document | Version unique per project; approval is draft/review/approved/superseded |
| `deliverable_revisions` | Before/after report history | Actor is user, AI, or system; changed sections are recorded |
| `qa_findings` | Deterministic and historical QA results | Severity and resolution are separate; blocker policy is enforced in domain/services |
| `audit_events` | Workflow-change log | Optional project FK; before/after snapshots are JSONB |
| `ai_runs` | Provider-stage provenance and outcome | Prompt version, input/output references, timing, usage, and failure code |
| `jobs` | Durable future work record | No worker consumes it in the current implementation |
| `project_exports` | Persisted export metadata | Path, SHA-256, byte size, project, deliverable, format, and current/stale state |

## Key enumerations

### Project state

```text
INTAKE -> SCOPING -> PLANNING -> RESEARCHING -> SYNTHESIZING
       -> QA -> APPROVAL_REQUIRED -> APPROVED -> DELIVERED -> ARCHIVED
```

The database constrains valid values but does not encode every arrow. Service functions enforce the implemented transitions. Project approval is separately `NOT_REQUESTED`, `PENDING`, `APPROVED`, or `REJECTED`.

### Source and evidence state

- Source availability: `AVAILABLE`, `ARCHIVED`, `PAYWALLED`, `REMOVED`, `UPLOAD`.
- Source reliability: `A`, `B`, `C`, `D`, `UNRATED`.
- Freshness: `CURRENT`, `AGING`, `OUTDATED`, `UNKNOWN`.
- Ingestion method: `MANUAL`, `FETCH`, `UPLOAD`, `SEARCH`, `IMPORT`, `REUSE`.
- Evidence verification: `PENDING`, `VERIFIED`, `REJECTED`.
- Evidence support extent: `FULL`, `PARTIAL`.

Freshness is recalculated from `published_at`, the project's `research_date`, and `source_max_age_days`. Missing/future publication dates are `UNKNOWN`; age beyond the maximum is `OUTDATED`; the final 20% of the allowed age window is `AGING`.

### Claim state

- Claim type: `FACT`, `INTERPRETATION`, `INFERENCE`, `RECOMMENDATION`.
- Importance: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`.
- Support: `SUPPORTED`, `PARTIALLY_SUPPORTED`, `CONTESTED`, `UNSUPPORTED`, `OUTDATED`, `NOT_VERIFIABLE`.
- Explicit classification: `FACT` or `INFERENCE`.
- Verification possible and within approved scope: explicit booleans.

Support is derived from verified non-context evidence. Both support and refutation yield `CONTESTED`; no verified support yields `UNSUPPORTED`; only outdated support yields `OUTDATED`; partial or stale usable support can yield `PARTIALLY_SUPPORTED`.

### QA and jobs

- QA severity: `BLOCKER`, `HIGH`, `MEDIUM`, `LOW`.
- QA resolution: `OPEN`, `RESOLVED`, `ACCEPTED_RISK`.
- Job state: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

The strict domain rule treats a blocker as blocking unless its resolution is `RESOLVED`. `ACCEPTED_RISK` remains useful for recording a decision on non-blocking findings, but it does not clear a blocker.

## Integrity and lifecycle

- Project-owned questions, plans, sources, claims, findings, reports, QA, AI runs, jobs, audit events, and export records cascade when the project is deleted.
- Evidence cascades with its source; claim/evidence and finding/claim joins cascade with either side.
- Deleting a client sets the project's `client_id` to null.
- Deleting a reused or canonical source clears the corresponding source self-link.
- Deliverable deletion cascades its revisions, related QA finding links, and export records.
- Service writes use transactions for multi-record state transitions and parameterized values for SQL input.

Project deletion is exposed by the API and is destructive. The service commits the database cascade and global deletion audit first, then recursively removes only the validated `<STORAGE_DIR>/uploads/<projectId>` and `<STORAGE_DIR>/exports/<projectId>` directories. If file cleanup fails, the database remains deleted, a global failure audit is written, and the API returns an error. The implementation does not provide soft deletion, restore, retention enforcement, or automatic backups.

## JSONB and arrays

JSONB is used for bounded, version-tolerant records: workspace quality defaults, client contact information, source fetch metadata, report sections, deliverable export lists, QA metadata, audit snapshots, AI usage/input/output references, and job payloads. PostgreSQL arrays store requested formats, search queries/source types/comparison targets/risks, and changed report sections.

These fields still require application validation. JSONB presence alone is not completion evidence, and the schema does not make arbitrary JSON safe to render or send to a provider.

## Indexes

Indexes cover workspace/status project lookup, deadlines, project-owned question/source records, source hashes, evidence sources, claim support, QA status/severity, descending project audit time, and runnable job schedule. Indexes reflect the expected local workflow but have not been load-tested for a multi-tenant production volume.
