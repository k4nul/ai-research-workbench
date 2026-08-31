# Providers, evaluation, and budgets

## Selection boundary

AI Research Workbench has typed AI and search provider interfaces. Deterministic mock providers are the default and are the only providers required by normal tests and release evaluation.

| Capability | Mock | Optional live |
| --- | --- | --- |
| Structured AI stages | `mock-ai` | OpenAI Responses |
| Search | deterministic mock search | Brave Search |

Provider selection is frozen into each research run. In demo mode, or when a required key is absent, the matching mock adapter is selected. Turning off demo mode does not manufacture credentials: a run frozen to an unavailable live provider blocks with a configuration error.

Mock output is synthetic and deterministic. It proves schema, orchestration, persistence, replay, QA, and UI behavior against fixtures. It does not prove the factual quality, availability, latency, pricing, safety, or compatibility of a live provider.

## Provider request boundary

Each research stage builds a versioned request with:

- pipeline, stage, and prompt-template version;
- project/run/stage identifiers;
- canonical input hash;
- an explicit source-ID allowlist;
- source content labeled as untrusted data;
- structured output schema and maximum output bounds;
- client request ID, timeout, and abort signal.

The OpenAI adapter uses the Responses API with strict JSON Schema output and `store: false`. The Brave adapter makes a bounded search request and normalizes result metadata. Search results are discovery metadata, not verified evidence; use the safe-fetch path separately to retrieve and sanitize a selected public URL.

Successful output is parsed with the stage Zod schema. Unknown or cross-project source IDs are rejected before domain commit. Provider responses never approve a plan, clear deterministic QA blockers, approve a deliverable, or grant permission to deliver.

## Execution provenance

`provider_executions` records provider, model, operation, status, request/response identifiers, input/output hashes, retry count, token usage, cost status, estimated cost, error class, bounded error, timestamps, and latency. Duplicate provider response IDs are rejected so replay cannot silently reuse the same purported upstream execution under a different local record.

The run and stage rows aggregate requests, searches, tokens, attempts, elapsed time, and cost. Audit and job histories remain separate: provider execution proves an adapter attempt, a job event proves durable queue state, and a domain commit proves accepted local effects.

## Rate and concurrency permits

Before live or mock AI execution, a worker acquires a PostgreSQL permit scoped to provider and operation. The rate window stores request count/limit and concurrent in-flight count/limit. Defaults are 60 requests per 60 seconds and two in-flight requests. Permit TTL is at least the configured job lease/default timeout and at most one hour, allowing capacity to recover after process death.

A denied permit becomes a retryable provider-rate-limit job error with a delay. These limits coordinate workbench processes. They are not a replacement for the provider's own quotas, spend caps, usage dashboard, or incident controls.

The internally seeded deterministic release evaluation is the sole scope
exception. Its frozen run snapshot carries a strict non-API execution marker,
and each marked mock run uses a distinct permit operation for its eleven stages.
This prevents a separately polling worker or a still-open ordinary mock window
from making the repeatability gate depend on process claim timing. Unmarked mock
runs and all live providers continue to share `ai.run`; the exception never
bypasses a live-provider account limit.

## Frozen run budgets

Default limits are:

| Resource | Default |
| --- | ---: |
| Provider requests | 40 |
| Search requests | 30 |
| Input tokens | 500,000 |
| Output tokens | 100,000 |
| Estimated cost | USD 25 |
| Elapsed time | 3,600,000 ms |
| Stage attempts | 3 |
| Sources | 100 |
| Document chunks | 2,000 |

The run stores its budget snapshot; later configuration changes do not silently change that run's contract. Before each call, current usage plus the requested increment is checked. A violation blocks the stage/run with a non-retryable budget classification.

Cost status is one of:

- `KNOWN`: a matching effective provider/model rate is configured;
- `ESTIMATED`: usage or rate requires an explicit estimate;
- `UNKNOWN`: the application cannot calculate a defensible price.

Only the deterministic mock model has a built-in known zero price. `MODEL_PRICING_JSON` can add provider/model input and output token rates, effective date, source, and status. Unknown live cost is never coerced to zero. If the run has a finite cost ceiling and the next call's cost is unknown, the call is blocked.

## Deterministic evaluation

`npm run eval:mock` runs the labeled synthetic corpus through durable PostgreSQL orchestration. It persists an `evaluation_runs` row and writes:

- `.artifacts/evals/mock/eval-summary.json`
- `.artifacts/evals/mock/eval-summary.md`

The release gate requires all ten fixtures to pass. Metrics include citation integrity/precision, supported-claim rate, evidence coverage, research-gap detection, conflict detection, unsupported critical claims, QA blocker bypass, cross-project evidence references, prompt-injection policy bypass, deterministic hash mismatch, reproducibility, and estimated cost.

The corpus is synthetic and versioned. Its score is a regression signal for the encoded fixture contract, not an estimate of real-world research accuracy. Adding or changing a metric requires updating its labeled gold set and threshold rather than interpreting unlabeled output after the fact.

## Live canary

`npm run test:providers:live` is an explicit, bounded compatibility canary:

- OpenAI receives a small synthetic intake prompt, at most 512 output tokens, and must return a request ID plus finite token usage;
- Brave receives a one-result safe-search query for public official documentation and must return a result plus request ID;
- no customer data or stored research content is used;
- each result is persisted in `provider_canary_runs`;
- status is `PASSED`, `FAILED`, or `NOT_RUN_NO_CREDENTIALS`;
- output sets `accuracyScore` to `null`.

The optional scheduled/manual workflow is `.github/workflows/live-canary.yml`. It is intentionally separate from required CI because it uses secrets, external networks, provider availability, and billable calls. A missing credential is reported, not counted as a passing live check.

`npm run eval:live` does not run or score an unlabeled live research corpus. With credentials it returns `NOT_APPLICABLE_USE_PROVIDER_CANARY`; without both keys it records `NOT_RUN_NO_CREDENTIALS`. This prevents a compatibility ping from being mislabeled as quality evidence.

## Failure and retry classification

Provider rate limits, server failures, network failures, and timeouts are retryable. Refusal, content filter, truncation, excessive response, invalid structured output, and unknown source references are non-retryable validation/security outcomes. Cancellation is cooperative. Sanitized errors are stored; raw credentials, response bodies, and provider secrets must not enter logs or fixtures.

Provider request IDs and usage should be used for reconciliation. If a call may have succeeded before the local lease/acknowledgement failed, assume it can be repeated and rely on the stable client request ID, execution history, stage fence, and idempotent domain commit. The queue does not promise exactly-once provider billing.

## Commands

```bash
npm run test:providers
npm run eval:mock
npm run test:providers:live
npm run eval:live
npm run smoke:research-run
```

Normal provider tests mock `fetch`, validate structured output and source-ID allowlists, and require no credentials. The smoke run executes all eleven stages against the deterministic provider and a migrated/seeded database.
