# AI pipeline

## Design goal

The AI boundary is a typed suggestion pipeline, not a source of workflow authority. Every stage accepts structured input, returns a stage-specific schema, records provider metadata, and rejects source identifiers outside the request allowlist. Deterministic domain rules and human approval remain separate.

## Stages

The provider contract defines eleven stages:

| Stage | Intended output |
| --- | --- |
| `intake_analysis` | Normalized brief observations, uncertainties, and scope issues |
| `question_decomposition` | Research questions with priorities and completion criteria |
| `research_plan` | Queries, source strategy, outputs, risks, and gaps |
| `source_summary` | Bounded summary and external-content risk flags |
| `evidence_extraction` | Minimal evidence units tied to allowed source IDs |
| `claim_generation` | Atomic typed claims tied to evidence |
| `gap_detection` | Missing evidence or unanswered-question records |
| `conflict_detection` | Conflicting-source records and resolution prompts |
| `report_outline` | Report-section plan |
| `draft_generation` | Typed report-section draft |
| `qa_revision` | Proposed edits responding to specified QA findings |

All stage outputs are validated with strict Zod schemas. Output that fails parsing, schema validation, or source-ID checks is rejected rather than coerced into workflow records.

## Provider selection

Provider selection is deliberately conservative:

```text
DEMO_MODE=true                    -> mock AI + mock search
DEMO_MODE=false, no provider key  -> corresponding mock provider
DEMO_MODE=false, OpenAI key       -> OpenAI adapter available
DEMO_MODE=false, Brave key        -> Brave adapter available
```

The default mock AI provider returns deterministic data for every stage. The mock search provider returns synthetic results. This supports offline development, repeatable tests, and a demo without cost or data transfer.

The selection helper masks keys in status output. It does not persist provider secrets to PostgreSQL.

## OpenAI Responses adapter

The optional adapter calls `POST https://api.openai.com/v1/responses` using the configured model. Requests include:

- `store: false`
- a stable JSON representation of stage input
- an instruction that external content is untrusted data and cannot override system/developer instructions
- `text.format` with `type: "json_schema"`, the stage schema, and strict validation
- project, stage, and prompt-template metadata
- bounded output and an abort timeout

The adapter extracts the response text, parses JSON, validates the stage schema, checks all returned source IDs against `allowedSourceIds`, and records request ID, timing, model, usage, and input hash in the returned metadata.

Official reference: [OpenAI Responses API — create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Brave Search adapter

The optional search adapter calls Brave's web search endpoint with `X-Subscription-Token`, a bounded query and result count, moderate safe search, and optional country/language/freshness parameters. It strips result-description HTML to text, validates result URLs, removes duplicate URLs, and applies an abort timeout.

Official references:

- [Brave Search API — web search endpoint](https://api-dashboard.search.brave.com/api-reference/web/search/get)
- [Brave Search API quickstart](https://api-dashboard.search.brave.com/documentation/quickstart)

A safe search result URL is not the same as safely fetching its page. Page retrieval must pass through the SSRF-resistant URL-fetch boundary described in [Security](SECURITY.md).

## Source-ID containment

Provider requests enumerate the source IDs a stage may reference. Shared validation traverses output and rejects unknown source IDs. This prevents a syntactically valid model response from inventing provenance that is not present in the stage input.

Citation syntax and QA perform a second independent check when report content is reviewed. Multiple controls are intentional: schema validity alone does not prove provenance.

## Run provenance

The provider result type includes:

- provider and model
- stage and prompt-template version
- canonical input hash
- start time and duration
- provider request ID when available
- token/usage metadata when available

The database has an `ai_runs` table for these values plus status, input/output references, and error code. The seed demonstrates a mock run. `GET/POST /api/projects/:projectId/pipeline` lists runs or executes one requested stage. Before execution the service validates that every allowed source belongs to the project, inserts `RUNNING`, invokes the selected provider, then records `SUCCEEDED`, `FAILED`, or `REJECTED` plus an audit event.

## Current wiring and verification limits

- Research-plan generation runs persisted `question_decomposition` (when needed) and `research_plan` provider stages, applies validated suggestions as AI-suggested records, and requires human plan approval. The local deterministic mock remains the default provider.
- The pipeline route runs one explicit stage and records its result; it does not automatically sequence stages or apply successful output to questions, evidence, claims, findings, or reports.
- Source search calls the selected search adapter and registers hit metadata/snippets. A separate fetch route can retrieve a chosen URL through the safe-fetch boundary; search hits are not automatically fetched or verified.
- Provider unit tests mock network calls; they do not prove current OpenAI model availability, account permissions, Brave subscription behavior, quota, latency, or live schema conformance.
- Live calls have not been exercised without provider keys and must not be described as verified.
- There is no background worker; provider/search calls run synchronously in their route request.
- Model output can still be inaccurate, biased, incomplete, or adversarial. Human evidence verification, deterministic QA, and approval remain required.

## Production orchestration requirements

Before turning the stage-by-stage API into an automatic production orchestrator:

1. Define the exact stage transition and idempotency key.
2. Persist a `RUNNING` AI run before the call and terminal status afterward.
3. Pass only the minimum sanitized external content and allowed source IDs.
4. Apply per-user/tenant authorization and a distributed usage limit.
5. Bound time, output size, retry behavior, and provider cost.
6. Treat provider errors as recoverable workflow failures, not partial success.
7. Require user review before persisting generated evidence, claims, or report text as accepted state.
8. Add integration tests with recorded/synthetic fixtures and a separately approved live-provider smoke lane.
