# Research workflow

## Workflow overview

The workbench separates research operations into reviewable gates. A model-generated suggestion, a database status value, or a checked box cannot skip a gate.

```text
Intake
  -> scope approval
  -> question decomposition and plan approval
  -> source and evidence collection
  -> claim ledger and conflict resolution
  -> findings and report
  -> strict QA
  -> human approval
  -> export and delivery
```

The route handlers expose the workflow as JSON APIs. Browser pages cover dashboard, project intake/list/overview, scope, plan, source acquisition/detail/evidence, claim/evidence ledger, findings, report/revisions, QA, approval/export, audit, and read-only provider settings.

## 1. Intake and scope

Project intake captures a name, core question, purpose, audience, scope, exclusions, jurisdiction, research date, maximum source age, deadline, requested formats, and special requirements. Inputs can be submitted directly or imported from bounded JSON/Markdown text.

Creating a project starts the workflow in intake/scoping. Scope approval records `scope_approved_at`, advances the state, emits an audit event, and contributes the first progress gate. Editing material scope fields clears downstream plan/QA/approval state so stale approvals cannot survive a changed brief.

Relevant routes:

- `GET/POST /api/projects`
- `POST /api/projects/import`
- `GET/PATCH/DELETE /api/projects/:projectId`
- `POST /api/projects/:projectId/scope`

Project deletion removes the database graph first, records a global deletion audit event, and then removes that project's private upload/export directories. A file-cleanup failure is reported after the database deletion and recorded as a global storage-cleanup failure. There is no restore without a database and file backup.

## 2. Questions and research plan

Questions carry priority, completion criteria, status, and an explicit gap state. A plan is unique per question and records the search strategy, queries, preferred source types, comparison targets, expected output, completion condition, risks, and optional gap.

`POST /api/projects/:projectId/plan` supports:

- `generate`: runs configured-provider question decomposition when no questions exist, then generates and stores one suggested plan per question (the deterministic mock provider is the default).
- `save`: validates and stores a supplied plan.
- `approve`: records human approval for one plan or the project plan set.

The generate action is rate-limited in process and can call the live OpenAI adapter only when demo mode is off and a key is configured. Each provider run stores its validated input snapshot/hash and output provenance. Plan approval remains a separate human decision from `ai_suggested`, and every question must have an approved plan before the project plan is complete. Adding a question or saving a plan clears the project-level plan approval timestamp until the full set is approved again.

Questions can be added and updated through:

- `POST /api/projects/:projectId/questions`
- `PATCH /api/projects/:projectId/questions/:questionId`

## 3. Sources and evidence

A source record captures URL or upload provenance, title, publisher, author, dates, type, language, availability, reliability, freshness, duplicate and reuse links, content hash, restrictions, ingestion method, media type, summary, sanitized content, prompt-injection flag, and fetch metadata.

The implemented source APIs support structured source creation, listing, detail, and reuse:

- `GET/POST /api/projects/:projectId/sources`
- `POST /api/projects/:projectId/sources/reuse`
- `POST /api/projects/:projectId/sources/search`
- `POST /api/projects/:projectId/sources/fetch`
- `POST /api/projects/:projectId/sources/upload`
- `POST /api/projects/:projectId/sources/import`
- `GET /api/sources/:sourceId`

Search registers normalized result metadata and snippets; it does not automatically fetch or verify each page. Fetch separately applies DNS/IP/redirect/time/byte/media-type controls and stores sanitized text plus hop metadata. Upload validates and stores permitted bytes in a private project directory; text/HTML/JSON can be normalized, while PDF/DOCX remain binary sources requiring manual evidence or a future extraction adapter. Imports accept bounded JSON source arrays or one Markdown source. None of these paths performs malware scanning.

Evidence is attached to a source through `POST /api/sources/:sourceId/evidence`. Each record stores a concise summary, optional minimal quote, original location/page, confidence, verification state, and `FULL` or `PARTIAL` support extent. The system relies on a human or a trusted upstream process to mark evidence verified; provider output does not self-verify.

## 4. Claims and evidence ledger

Claims are atomic statements classified by type, importance, fact/inference status, verification possibility, approved-scope status, and report inclusion. A join record links evidence as `SUPPORTS`, `REFUTES`, or `CONTEXT`.

Support is calculated only from verified supporting/refuting evidence:

- both support and refutation → `CONTESTED`
- no verified support → `UNSUPPORTED`
- only outdated verified support → `OUTDATED`
- usable full support → `SUPPORTED`
- partial or otherwise limited usable support → `PARTIALLY_SUPPORTED`
- explicitly impossible to verify → `NOT_VERIFIABLE`

Routes:

- `GET/POST /api/projects/:projectId/claims`
- `PATCH /api/projects/:projectId/claims/:claimId` to record inclusion, scope, or conflict-resolution decisions
- `GET /api/projects/:projectId/ledger`
- `POST /api/projects/:projectId/ledger` to create a claim/evidence relationship

The claim/evidence progress gate independently requires every included claim to be verifiable and have at least one `VERIFIED` evidence link with a `SUPPORTS` relationship. Support status is recalculated from verification, relationship, freshness, and support extent after evidence/scope mutations; a manually asserted status is not proof.

## 5. Findings and report

Findings synthesize one or more claims and record importance, impact, limitations, and whether they can inform a recommendation. The API supports listing and creation through `GET/POST /api/projects/:projectId/findings`. Approval requires every finding to link at least one report-included, verifiable claim with a `VERIFIED` `SUPPORTS` evidence link.

The latest report is a versioned deliverable with eleven sections:

1. Research purpose
2. Executive summary
3. Research scope
4. Methodology
5. Key findings
6. Detailed analysis
7. Comparison table (optional)
8. Risks and limitations
9. Recommendations
10. References
11. Appendix (optional)

Project creation creates the initial blank deliverable in the same transaction. `GET /api/projects/:projectId/deliverable` is read-only and returns the latest version and history. `PUT` updates content and records a before/after revision with the changed sections. Citations use bracketed source IDs such as `[source-demo-2]`.

## 6. QA

`POST /api/projects/:projectId/qa` locks the project, builds a typed context from that serialized database snapshot, runs all fourteen rules, replaces prior open engine-generated findings, persists the new findings, writes an audit event, and moves the project to either `QA` or `APPROVAL_REQUIRED`. A concurrent material mutation either precedes that snapshot or runs afterward and invalidates it. `GET` lists findings in severity order.

`PATCH /api/projects/:projectId/qa/:findingId` records `RESOLVED` or `ACCEPTED_RISK`. Strict blocker semantics apply: a blocker is clear only when `RESOLVED`. Rerun QA after changing evidence, claims, conflicts, gaps, or report content. See [QA rules](QA_RULES.md) for service-level heuristics and current limitations.

## 7. Human approval

Approval is a three-action state machine on `POST /api/projects/:projectId/approval`:

1. `request` requires approved scope; an approved plan for every question; completed questions or accepted/resolved gaps; included verifiable claims backed by `VERIFIED` `SUPPORTS` links; findings linked to those reportable claims; all nine required sections in the latest report; a fresh QA pass; and no unresolved blocker. It then sets approval pending.
2. `approve` requires a pending request and `confirmation: true`, then records the approval timestamp and approves the current deliverable.
3. `deliver` requires approval and a generated ZIP, then records delivery.

These are local workflow actions. There is no authenticated approver identity, signature, email, or external notification. Audit labels indicate the local actor type, not proof of identity.

## 8. Exports and delivery

`GET /api/projects/:projectId/exports/:format` generates `markdown`, `html`, `pdf`, `docx`, `csv`, or `zip`; `?persist=true` writes an artifact under the configured private storage directory and records its hash and size. The approval page presents the project's requested review formats plus ZIP. ZIP is always required, persisted, and approval-gated. Material research/report changes mark every earlier export non-current; delivery requires a newly generated current ZIP.

Non-ZIP files can support review before approval. They must not be represented as final approved delivery. See [Export formats](EXPORT_FORMATS.md).

## Progress gates

| Gate | Evidence checked |
| --- | --- |
| Scope confirmed | `scope_approved_at` exists |
| Plan approved | every question has an approved plan and the project plan timestamp exists |
| Questions researched | questions meet completion expectations and no open gap remains |
| Claims linked to evidence | included claims have verified support links |
| Report written | latest deliverable contains the required report content |
| QA passed | QA pass timestamp and no unresolved blocker |
| Human approved | approval status/timestamp complete |
| Deliverables generated | a current persisted ZIP package exists |

Each gate is worth one eighth. The persisted `progress` value is refreshed after workflow mutations; it is a rollup, not an independent source of truth.

## Audit trail

State-changing services write an event with actor type/label, action, resource, optional before state, optional after state, and timestamp. `GET /api/audit` supports read access to audit records. Audit events are useful provenance but are mutable database records in a single-user local system, not tamper-evident compliance logs.
