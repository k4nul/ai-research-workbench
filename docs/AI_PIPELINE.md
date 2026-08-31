# AI pipeline

## Authority model

The pipeline proposes structured research records; it does not establish truth or approve its own output. Source content and model output are untrusted. Strict schemas, source-ID allowlists, deterministic QA, stored provenance, and human plan/final approval form the acceptance boundary.

## Versioned stages

`research-pipeline.v2` runs these dependency-ordered stages:

| Ordinal | Stage | Main output |
| ---: | --- | --- |
| 1 | `intake_analysis` | normalized objective, constraints, success criteria |
| 2 | `question_decomposition` | research questions and completion criteria |
| 3 | `research_plan` | methods, source targets, priorities |
| 4 | `source_summary` | source summaries and quality signals |
| 5 | `evidence_extraction` | evidence candidates tied to allowed sources |
| 6 | `claim_generation` | claims and evidence relationships |
| 7 | `gap_detection` | unanswered questions and evidence gaps |
| 8 | `conflict_detection` | conflicting evidence/claim candidates |
| 9 | `report_outline` | required-section outline |
| 10 | `draft_generation` | structured report draft |
| 11 | `qa_revision` | bounded revision suggestions |

The stage catalog in `lib/execution/stages.ts` is canonical for dependencies, prompt-template version, structured-schema version, timeout, and maximum attempts.

## Run creation

A run requires an existing project and approved plan revision. Creation freezes:

- scope and plan revision IDs;
- pipeline version;
- provider/model configuration;
- run budget;
- canonical request hash;
- creator and timestamps.

An idempotency key returns the existing identical run and rejects drift. Initial stage generations are created once, and the first ready stage is submitted as `RESEARCH_PIPELINE_STAGE`.

## Worker execution

For each attempt the handler:

1. validates the job's run/stage/project linkage and establishes the job/stage/attempt/worker fence;
2. loads the frozen orchestration bundle;
3. reuses already committed output when replaying;
4. builds stage input from only approved/current project records;
5. selects the frozen mock or live provider;
6. checks frozen budget and acquires a PostgreSQL provider permit;
7. records the provider execution and invokes with timeout/cancellation;
8. parses the strict stage schema and validates all source references;
9. commits output and domain effects in the fenced idempotent transaction;
10. advances dependent stages or moves the run to its review state.

Lease loss or a newer generation prevents a stale attempt from starting or committing. The queue remains at least once, not exactly once; provider calls can repeat around failure boundaries.

## Applying output

Stage adapters can persist questions, planning data, source summaries, evidence, claims, gaps, conflicts, report outline/draft revisions, and QA-revision material. The stored output hash and domain commit connect the provider response to accepted effects.

Pipeline output cannot:

- approve or replace the human-approved plan revision;
- reference a source outside the explicit project allowlist;
- clear deterministic QA blockers by itself;
- approve the deliverable or create delivery authority;
- make a prior stale citation current;
- override budget, authorization, scan, or storage gates.

## Restart and resume

Pipeline jobs cannot use generic manual retry. A stage rerun creates a new generation with the stored input, marks downstream generations stale, and submits a new job. Prior generations remain visible for audit/reconciliation. Resume is available only when the run state and latest stage permit it.

Cancellation requests all active run jobs. Active handlers stop cooperatively or at lease expiry. Remote provider execution may not stop immediately.

## Provider boundary

The deterministic mock adapter is default and fixture-only. Optional OpenAI Responses uses strict structured output and `store: false`; optional Brave Search discovers result metadata. Search hits are not automatically fetched or verified. The safe-fetch route separately applies DNS/IP/redirect/time/byte/media controls.

Prompt input includes the instruction to treat source content as untrusted data and ignore embedded instructions. Prompt-injection heuristics persist review signals but are not a complete defense. Provider output source IDs are checked against the request allowlist after parsing and before commit.

See [Providers, evaluation, and budgets](PROVIDERS_EVALUATION.md).

## Provenance

The durable trail includes:

- run and stage versions/generations;
- job, attempt, and event history;
- provider/model, request/response ID, prompt/schema version;
- canonical input/output hashes;
- latency, retry count, tokens, cost status/estimate;
- source allowlist and validated output references;
- domain-commit key/hash;
- actor-labeled audit events for operator/system state changes.

These records support review and replay diagnosis. They are not a cryptographic chain and do not make upstream provider claims true.

## Evaluation

`npm run eval:mock` executes ten labeled synthetic fixtures through durable orchestration and checks citation/support/gap/conflict/security/reproducibility metrics. `npm run test:providers:live` is a separate bounded compatibility canary. `npm run eval:live` never assigns an unlabeled accuracy score.

## Verification

```bash
npm run test:providers
npm run test:workers
npm run test:integration
npm run eval:mock
npm run smoke:research-run
```

Normal tests mock external fetch and require no provider keys. Live calls must be explicitly authorized and run only through the canary.
