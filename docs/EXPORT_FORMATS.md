# Export formats

## Export boundary

Exports are generated from the latest deliverable plus the current project, sources, claim/evidence graph, and QA records. `GET` generation is synchronous, read-only, and in memory; any legacy `?persist` query is rejected. `POST` freezes the current export snapshot and queues durable persistence for a separate worker. ZIP generation is approval-gated, and delivery requires a current ZIP persisted through the POST/worker path.

Route:

```text
GET /api/projects/:projectId/exports/:format
POST /api/projects/:projectId/exports/:format
```

Supported route values are `markdown`, `html`, `pdf`, `docx`, `csv`, and `zip`.

The authenticated `POST` mutation requires the normal origin/CSRF controls and an `Idempotency-Key` header. It returns `202` with the durable job identifier and whether the job was newly created. The central HTTP receipt scopes the key by principal, method, and route and returns the exact original response; the export service additionally scopes the durable job to project and format. Reusing a key with changed body/query is rejected. The queued payload contains the frozen content hash, deliverable revision, approval/QA state, and trusted requesting operator. Before committing an object, the worker rechecks that snapshot plus its database-time lease owner and attempt. A stale snapshot, cancellation, or lost lease cannot publish a current artifact. Worker delivery remains at-least-once; deterministic input/object keys and transactional fences make the domain effect idempotent, not the handler exactly-once.

## Standalone formats

| Format | Filename | Media type | Content |
| --- | --- | --- | --- |
| Markdown | `final-report.md` | `text/markdown; charset=utf-8` | Title, sample notice, research date, eleven report sections |
| HTML | `final-report.html` | `text/html; charset=utf-8` | Standalone escaped report with inline print styles |
| PDF | `final-report.pdf` | `application/pdf` | A4 report rendered with PDFKit |
| DOCX | `final-report.docx` | Office Open XML document | Report title, sample notice, research date, headings, paragraph lines |
| CSV | `claim-evidence-ledger.csv` | `text/csv; charset=utf-8` | One row per claim/evidence link, plus unlinked claims |
| ZIP | `delivery-package.zip` | `application/zip` | Approved delivery bundle described below |

The standalone CSV is the claim/evidence ledger, not the source list. It includes claim scope and evidence support extent. All cells are quoted, internal quotes are doubled, and values beginning (after leading spaces, tabs, or carriage returns) with `=`, `+`, `-`, or `@` are prefixed with an apostrophe to neutralize common spreadsheet-formula interpretation. Consumers should still import untrusted CSV as text and apply their own spreadsheet policy.

## Approval gates

Non-ZIP exports support drafting and review and are not automatically evidence of final approval. `ZIP`, or any internal call with `requireApproval`, checks that:

- project approval is `APPROVED`; and
- the export gate sees no blocker whose status is other than `RESOLVED`.

Human approval requires a prior approval request and explicit confirmation. Delivery additionally requires a current persisted ZIP record. Material workflow changes, QA reruns, and QA finding-resolution changes invalidate prior approval and mark earlier exports stale. Persistence rechecks the locked project, approval, QA, and latest-deliverable revision after rendering, so an in-flight artifact from an older snapshot cannot become current after a revision. Final tests must prove any blocker whose status is not `RESOLVED` cannot be delivered, including after an earlier approval.

## ZIP inventory

The delivery archive contains exactly:

```text
final-report.md
final-report.html
final-report.pdf
final-report.docx
sources.csv
claim-evidence-ledger.csv
qa-findings.json
project-metadata.json
README.txt
```

`sources.csv` keeps publication and access dates in distinct fields and includes publisher, author, URL, type, reliability, freshness, and usage restrictions. `claim-evidence-ledger.csv` maps claims (including scope) to relationships, support extent, evidence summaries/minimal quotes, and source identifiers/titles. `qa-findings.json` contains rule, severity, location, problem, remediation, resolution, and timestamps. `project-metadata.json` includes schema version 1, generation time, the project object, deliverable ID/version/title, and fixture status.

Seeded exports visibly say `SAMPLE FIXTURE` and must never be presented as real research.

## Persistence and integrity metadata

Persistence uses the same private local/S3 object abstraction as documents. The generated object key is derived from the canonical export input hash under the `exports` category. Local storage contains paths below `<STORAGE_DIR>/objects/private`, refuses path/symlink escape, requests `0700` directories and `0600` files, and verifies bytes on read. S3 uses one configured private bucket, conditional creation, SHA-256 metadata, head/read verification, and bounded signed URLs.

Each artifact reserves a `storage_objects` row and a `project_exports` row with project, deliverable, format, object reference, canonical input hash, SHA-256, byte size, persistence state, current/stale state, duration, and bounded failure. The write is then verified and finalized. The same unchanged project/format/input hash reuses verified bytes; drift or missing/hash-mismatched bytes cannot be returned as current. Material research or QA changes set prior rows to `is_current = false`.

The hash records byte identity when compared with trusted metadata; it is not a signature. The repository does not configure object lock, encryption keys, lifecycle, retention, backup, or later scheduled integrity checks.

## Renderer behavior

- Markdown and HTML include `_Not provided_`/`Not provided` for absent sections.
- HTML escapes the title and every report section rather than rendering stored markup.
- PDF uses `PDF_FONT_PATH` and optional `PDF_FONT_NAME` when set, then tries the container's Korean Noto Sans CJK face, Noto Sans, Unifont, IPA Gothic, and DejaVu Sans paths before PDFKit's default font.
- DOCX uses the `docx` package document model and splits section text by newline into paragraphs.
- PDF/DOCX include all eleven sections, including optional ones as `Not provided` when empty.

The container installs Noto Sans CJK and runs both a Hangul glyph-map check and a generated-PDF text round-trip smoke. Set and test `PDF_FONT_PATH`; for a TTC collection, also set its `PDF_FONT_NAME`, when a deployment requires different language coverage.

## Operational verification

The repository provides:

```bash
npm run export-demo
npm run export-demo -- --approve
```

The first writes review copies of Markdown, HTML, PDF, DOCX, and CSV under `exports/demo`. The `--approve` form mutates demo approval state, adds ZIP generation, and persists the ZIP through configured object storage. These commands require migrated and seeded PostgreSQL.

For a handoff, inspect behavior rather than only file existence:

1. Confirm every file has a nonzero size and expected media/signature.
2. Open HTML in a browser and print-preview it.
3. Parse and visually inspect every PDF page; check wrapping, page breaks, citations, sample labeling, and non-Latin glyphs if required.
4. Open DOCX in at least one target office suite; check headings, line breaks, citations, and sample labeling.
5. Parse CSV with a compliant reader; verify CRLF rows, quotes, Unicode, link cardinality, dates, and restrictions.
6. List and open every ZIP member; compare source/ledger/QA metadata to PostgreSQL.
7. Read the persisted object, recompute SHA-256, and compare it with both `project_exports` and `storage_objects`.
8. Attempt ZIP before approval, with an open blocker, and with an accepted-risk blocker; each must be denied.

No current script performs all of those semantic and visual checks automatically. Record actual artifact-inspection results at handoff.
