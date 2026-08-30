# Product

## Product statement

AI Research Workbench is a local research-operations MVP for producing source-backed reports with an inspectable evidence chain and an explicit human delivery decision. It is designed for a researcher or small research team that needs more rigor than a chat transcript but does not yet need a multi-tenant research platform.

The product promise is narrow: every material report claim should be traceable to verified evidence, every known gap or conflict should remain visible, and no final delivery bundle should be created until strict QA and human approval have completed.

## Users and jobs

| User | Job | Current implementation |
| --- | --- | --- |
| Research operator | Turn a brief into questions, a plan, sources, claims, findings, and a report | Project/workflow APIs, PostgreSQL records, and provider-backed plan suggestions (mock by default) |
| Reviewer | Check provenance, limitations, conflicts, and QA findings | Claim/evidence ledger, revisions, QA records, audit events |
| Approver | Make the final delivery decision | Explicit request/approve/deliver transitions and approval-gated ZIP |
| Local evaluator | Exercise the complete data model without provider keys | Synthetic `project-demo` seed and mock providers |

The current application treats these as workflow roles, not authenticated identities. It runs as a single trusted local user.

## Core principles

1. **Evidence before prose.** Sources are registered, evidence is extracted and verified, and claims are linked before findings or recommendations are trusted.
2. **AI proposes; code and people decide.** Provider output is schema-validated and source-ID bounded. Deterministic rules and human approval remain outside the model.
3. **Uncertainty stays visible.** Outdated sources, duplicates, refuting evidence, and research gaps are recorded rather than silently removed.
4. **Completion requires proof.** Progress derives from eight workflow gates. A `100%` value is not a substitute for QA, approval, exports, tests, or artifact inspection.
5. **The demo is unmistakably synthetic.** Seeded data uses `[SAMPLE]`, fixture metadata, and example-only URLs.

## Implemented capability

- Quick, detailed, JSON, and Markdown project-intake validation.
- Project, scope, question, and research-plan persistence.
- Manual/search/fetch/upload/import/reuse source acquisition with freshness, duplicate, provenance, private-storage, and sanitized-content fields.
- Evidence verification and claim relationships (`SUPPORTS`, `REFUTES`, `CONTEXT`).
- Claim support calculation from verified evidence and source freshness.
- Findings linked to claims.
- An eleven-section report with revision history.
- Fourteen deterministic QA rules and persisted findings.
- Scope, plan, QA, approval, and delivery state transitions with audit records.
- In-process Markdown, HTML, PDF, DOCX, CSV, and ZIP export generation.
- Mock AI/search providers plus optional OpenAI and Brave adapters, a provider-status route, and a one-stage-at-a-time persisted pipeline route.
- PostgreSQL-backed service APIs, raw migrations, local Compose, CI configuration, and diagnostics.

## Completion definition

A research project is complete only when all eight gates are true:

1. Scope confirmed.
2. Plan approved.
3. Questions researched.
4. Included claims have usable support, with evidence verification and scope decisions recorded.
5. Report written.
6. QA passed with no unresolved blocker.
7. Human approved.
8. A current persisted ZIP delivery package generated.

The resulting progress values are rounded eighths (`0`, `13`, `25`, `38`, `50`, `63`, `75`, `88`, `100`). A blocker marked `ACCEPTED_RISK` is still a blocker; only `RESOLVED` clears it.

## Current product boundary

The current checkout provides domain logic, PostgreSQL services, route handlers, exports, a responsive shell, and browser pages for dashboard, project list/create/overview, scope, plan, sources/detail/evidence, claim/evidence ledger, findings, report/revisions, QA, approval/export, audit, and read-only provider settings.

Source acquisition exposes manual entry, provider search, SSRF-resistant URL fetch, multipart upload, JSON/Markdown import, and reuse. The typed pipeline route can run and persist any one AI stage. Normal plan generation applies provider-backed question-decomposition/research-plan suggestions (mock by default), but the product is not an automatic end-to-end research agent and every suggested plan still requires human approval.

There is no production authentication, role enforcement, tenancy isolation, hosted object storage, worker, automatic delivery, collaborative editing, or customer-facing portal. The database has workspace/client fields for the domain model, but those fields do not constitute a security boundary.

Supported upload types are CSV, DOCX, HTML, JSON, Markdown, PDF, and plain text. Text/HTML/JSON content can be normalized; PDF/DOCX are stored with a manual-extraction notice. Recognition and signature validation do not imply malware scanning or complete document validation.

## Non-goals for the MVP

- Fully autonomous research or approval.
- A guarantee that source content, model output, or generated conclusions are true.
- Legal, medical, financial, or compliance advice.
- Crawling arbitrary sites or bypassing paywalls.
- Production identity, billing, collaboration, or multi-tenant administration.
- A general document editor or real-time collaboration suite.
- Pixel-perfect compatibility with every PDF reader, office suite, or font.

## Evidence of readiness

Readiness must be established by executing the commands in the root README, exercising state transitions through the APIs/browser surface that exists at handoff, inspecting generated files, and recording limitations. Configured scripts, source-file counts, screenshots, seeded status fields, or a stored `progress` value are supporting evidence only; none proves the full workflow by itself.
