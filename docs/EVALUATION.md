# Release evaluation

The mock release gate is a database-backed product evaluation, not a fixture
self-check. Run it after applying migrations:

```bash
npm run migrate
npm run eval:mock
```

The command creates ten visibly synthetic closed-corpus projects and executes
each one twice through the durable worker and all eleven research stages. The
mock provider is frozen in each run, so credentials and network access are not
used. An internal, frozen evaluation profile gives each of those runs its own
mock-provider permit operation. This keeps the deterministic gate repeatable
when an ordinary worker is polling the same database or a prior shared mock
request window is still open; ordinary mock and every live-provider run remain
on the shared `ai.run` window. The evaluator's worker also limits both lease
recovery and claims to the run IDs it just seeded, so it cannot execute or
recover unrelated pipeline work with its forced mock adapter. Ordinary workers
remain unrestricted and may safely claim marked evaluation work. Projects,
runs, stage outputs, provider
executions, sources, evidence, claims, QA findings, and reports remain persisted
for inspection.

## Inputs and labels

Synthetic product inputs live in `lib/evaluation/fixtures.ts`. Independently
reviewed expected labels live in `lib/evaluation/gold.ts`. Inputs never contain
observed detections, expected provider usage, or deterministic output. The ten
classes are supported evidence, conflict, stale evidence, numeric/unit conflict,
irrelevant material, prompt injection, insufficient evidence, partial answer,
duplicate source, and closed-corpus isolation.

Scoring reads observations back from PostgreSQL. Gaps and conflicts come from
persisted stage output; citations and required sections come from the persisted
report; provider requests and usage come from the persisted run and provider
executions. Random database identifiers are mapped to fixture keys before the
two independent executions are hashed. Set-like citation ordering is
canonicalized, but substantive stage, claim, gap, conflict, QA, or report
changes remain hash-significant.

The gate fails for any missing or cross-project citation, imprecise citation,
unsupported critical claim, missed stale/conflict/gap label, unresolved QA
blocker that reaches approval, prompt-injection bypass, incomplete stage/provider
execution, missing report section, wrong terminal boundary, or reproducibility
mismatch.

Artifacts use schema `research-eval-v2` and are written to
`.artifacts/evals/mock/eval-summary.json` and `eval-summary.md`. They include
both persisted run IDs for every fixture. Release verification requires twenty
distinct runs, complete eleven-stage/provider execution, and matching hashes.
The same JSON and Markdown bytes are also stored through the configured private
local/S3 object provider under generated `evaluations/` keys. Their catalog
references, SHA-256 values, sizes, and replay status are recorded in
`evaluation_runs.artifact_reference`; the local copies remain the inputs to the
release-asset packager.

Live output is unlabeled. `npm run eval:live` therefore always reports
`accuracyScore: null`; provider compatibility belongs to the bounded live
canary rather than this accuracy gate.
