# Document pipeline

## Boundary and state model

The durable document path accepts uploaded PDF, DOCX, TXT, HTML, Markdown, CSV, and JSON. The legacy source-upload URL and the document URL both enter this same quarantine, scan, private-storage, and extraction pipeline. Structured JSON/Markdown text import remains a separate bounded source-import operation and does not accept file bytes.

```text
upload -> QUARANTINED -> SCANNING
                         |-- CLEAN -> EXTRACTING -> READY
                         |                       |-- EXTRACTION_FAILED
                         |                       +-- OCR_REQUIRED_UNSUPPORTED
                         |-- REJECTED
                         +-- BLOCKED_SCANNER_UNAVAILABLE
```

Every state change is project-scoped, transactionally recorded, and audited. A document is linked to a source and a raw `storage_objects` row. Raw bytes are never placed under `public/`.

## Upload and quarantine

Before storage, the route and service enforce:

- a positive received size no greater than `MAX_UPLOAD_BYTES` (5,242,880 bytes by default; configuration caps it at 25,000,000);
- a leaf-only, NFKC-normalized filename with controls, bidirectional markers, separators, reserved Windows names, and excess length neutralized;
- an allowlisted extension and matching normalized MIME type;
- received byte count equal to declared size;
- `%PDF-` signature for PDF;
- ZIP container signature for DOCX;
- no NUL byte for text formats;
- valid UTF-8 JSON for JSON uploads.

The object is written under a generated `quarantine/<prefix>/<id>` key. The storage adapter verifies byte size and SHA-256 before database metadata is committed. If metadata persistence fails, the service attempts to delete the untracked object and reports a compensation failure if that cleanup also fails. After a real clean scan, the exact verified bytes are copied idempotently to a generated `sources/` key and the source points to that clean object; the quarantine object remains the immutable input linked to the scan record. An explicit demo scan bypass does not create or claim a clean-source object.

The source summary says that the object is awaiting scan/extraction. Quarantine is a state boundary; it is not evidence that the content is safe.

## Private storage

`STORAGE_PROVIDER=local` uses `<STORAGE_DIR>/objects/private`. Keys and bucket names are validated, path traversal and backslashes are rejected, resolved parents must remain below the configured root, symlinks are not followed, directories request mode `0700`, and files are created exclusively with mode `0600`. Reads are size-bounded and optionally SHA-256 checked.

`STORAGE_PROVIDER=s3` requires an endpoint, region, private bucket, access key, and secret. Writes use `If-None-Match: *`, store SHA-256 metadata, and verify the subsequent head response. Reads enforce the configured maximum and hash. Download URLs are bounded to the configured TTL, at most 900 seconds. The application does not configure bucket encryption, object lock, lifecycle, replication, or IAM; deployment owners must do so.

Document, generated extraction, evaluation, and export objects share the storage catalog but use distinct generated key categories. Every extraction writes a private, checksummed JSON artifact under an `extractions/` key and links it from the extraction row; a retry reuses only byte-identical content. Database catalog state does not itself prove that an object exists, so reads verify the backing object and integrity.

## Malware scanning

The production scanner is ClamAV over the `INSTREAM` protocol. The adapter:

- requests scanner/signature versions;
- frames the object in 64 KiB chunks;
- applies `MALWARE_SCAN_TIMEOUT_MS` (15 seconds by default);
- refuses objects above `MALWARE_MAX_FILE_BYTES` (25,000,000 by default);
- limits the scanner response to 8,192 bytes;
- sanitizes returned text and records only bounded errors;
- verifies that scanner byte size and SHA-256 match stored object metadata.

`CLEAN` advances the document. `INFECTED` produces `REJECTED`. Timeout, protocol error, unavailable scanner, object read failure, or integrity mismatch produces `BLOCKED_SCANNER_UNAVAILABLE` in the normal fail-closed path.

The mock scanner returns deterministic fixture results and is unavailable when `NODE_ENV=production`. An explicit bypass can treat an unavailable scan as clean only when all of these are true: non-production runtime, `DEMO_MODE=true`, and `MALWARE_ALLOW_DEMO_BYPASS=true`. The bypass is persisted and audited. Production configuration requires ClamAV, `MALWARE_REQUIRED=true`, and bypass disabled.

### Scanner limits

ClamAV integration is malware detection, not content disarm and reconstruction, sandbox execution, exploit detection, file reputation, or a guarantee against unknown malware. Its signature database must be updated and monitored by the deployment. The workbench buffers an object in memory before scanning, so configured upload/object/scan limits and container memory remain operational constraints. It does not recursively scan arbitrary embedded PDF attachments or every OOXML part as independent files.

## Extraction

Extraction requires the current object scan status to be `CLEAN`, except for the explicitly persisted local demo bypass described above. The object SHA-256 is checked again on read. Default extraction ceilings are:

| Limit | Default |
| --- | ---: |
| Object bytes | 25,000,000 |
| PDF pages | 500 |
| Text blocks | 20,000 |
| Extracted characters | 2,000,000 |
| DOCX ZIP entries | 2,500 |
| Expanded DOCX bytes | 100,000,000 |
| Compression ratio | 100:1 |
| XML part bytes | 20,000,000 |
| XML nodes | 500,000 |

All limits must be positive integers. The configured storage maximum supplies the active object byte ceiling.

### PDF

PDF.js parses with errors enabled, no worker fetch, no WASM, and no external resource fetching. The extractor bounds page count and reads only the text layer. Attachments, JavaScript actions, and open actions are reported as warnings/metadata; they are not executed. Encrypted/malformed documents fail. If no page has usable text, the result is `OCR_REQUIRED_UNSUPPORTED`; v0.2 does not perform OCR.

### DOCX

The bounded OOXML extractor rejects unsafe or absolute archive paths, traversal, encrypted/undecodable entries, excessive expansion or compression ratio, macros, ActiveX, embeddings, external relationships, DTD/entity declarations, excess XML bytes/nodes, and malformed ZIP/XML. It extracts the document body, tables, headings, footnotes, selected headers/footers, and bounded core properties. It does not render layout, execute fields/macros, fetch hyperlinks, or promise Microsoft Word visual fidelity.

### TXT, Markdown, CSV, JSON, and HTML

TXT, Markdown, CSV, and JSON use the same bounded UTF-8 text extractor and reject NUL or excessive control bytes; JSON syntax is also checked before quarantine. Paragraphs are normalized without executing content. This path extracts text and provenance, not spreadsheet cells or a semantic JSON tree. HTML must be valid UTF-8; it is sanitized through the research tag/attribute/scheme allowlist, does not fetch external resources, and records a warning when active or unsupported markup is removed.

## Blocks, chunks, and anchors

Each successful extractor emits ordered blocks with type, offsets, optional page/section location, content hash, confidence, and a stable anchor derived from document hash, extractor version, ordinal, structure, and content. The service scopes persisted block IDs to the extraction generation.

The structure-aware chunker defaults to 4,000 characters, 300-character overlap for oversized blocks, and at most 2,000 chunks. It avoids combining different pages/sections and starts a new group at headings. Each chunk has stable offsets, block bounds, content hash, chunker version, and security signals.

Each chunk creates a citation anchor containing source, document, extraction, chunk, offsets, optional page/section, and content hash. A new successful extraction marks prior current anchors `NEEDS_REVIEW` and marks linked evidence citations `NEEDS_REVIEW`. Anchors are durable provenance pointers, not proof that the quoted statement is true or that offsets survive arbitrary document changes.

The corresponding private extraction artifact contains the validated extractor result plus the exact generated blocks, chunks, and anchors. Its generated key never contains an uploaded filename. The database effects and catalog link commit together. A failed or interrupted final commit preserves its deterministic prewritten object for byte-identical retry; an object that remains unreferenced is eligible for untracked-object cleanup after the configured grace period.

Scan and extraction workers fence the initial state transition, every success or failure commit, and the post-scan extraction submission against the authoritative `RUNNING` job. The transaction locks the job and verifies its ID, exact attempt and lease owner, an unexpired database-time lease, and a version at least as new as the handler's claim (heartbeats legitimately advance that version). A delayed or reassigned attempt therefore cannot publish document, source, catalog, child-job, or audit effects. Because clean-source and extraction keys are deterministic, failed attempts leave prewritten bytes in place rather than risk deleting an object already reused by a successor; byte-identical retries reuse them and unreferenced leftovers remain eligible for grace-period orphan cleanup.

## Prompt injection

Extracted document text is always untrusted data. Heuristics look for instruction overrides, role reassignment, secret exfiltration, system-prompt probes, tool execution, jailbreak markers, and model control tokens. A score of at least two flags the source/chunk and stores indicator IDs.

Detection is intentionally a review signal. It has false positives and false negatives and does not sanitize meaning from plain text. Provider prompts separately instruct the model never to follow source-contained instructions and to use only allowlisted source IDs. No model or tool should receive raw document text outside that boundary.

## Downloads, deletion, and cleanup

Document download is authenticated and project-scoped. Local storage streams through the application because it cannot create a signed URL; S3 can return a short-lived URL. Both depend on current storage metadata and containment/integrity checks.

Document deletion and object cleanup are material operations. A first-time document delete refuses while any project job is nonterminal, except that queued/retry-waiting scan or extraction work for that exact document is cancelled in the deletion transaction. This prevents already-running work and queued research/export work from publishing results after the cleanup snapshot; cancel or drain such work before retrying. In the centrally receipted transaction, deletion locks the document's quarantine, promoted clean-source, and generated extraction rows, marks only active/pending rows for deletion, and submits one stable targeted `STORAGE_CLEANUP` job containing the exact object IDs. Replaying an already-deleted document returns the same cleanup job without reactivating `DELETED` objects. Any legal hold blocks the delete. Project deletion applies the same active-worker drain fence, submits the exact catalog object IDs it marked, and relies on that durable system-scoped job instead of removing legacy directories before the mutation receipt commits. Its worker drains bounded batches until none of those rows remains `PENDING_DELETE`. A tracked failure, expired claim, provider mismatch, or no-progress batch is retryable job failure rather than successful reconciliation. Catalog rows track upload, integrity, scan, extraction, and retention state. Before deleting a cataloged object, cleanup revalidates its owner and unexpired database-time lease under a row lock held through the backing-store delete and `DELETED` commit. A retry may reactivate an expired pending deletion before that fence is acquired, but cannot reactivate the row after the fenced delete begins. Cancellation is checked before and after claims, catalog operations, listings, and each physical delete; unprocessed claims are released before the aborted handler exits. Migrated local files are deleted only when their recorded regular-file path remains contained under the configured `uploads/` or `exports/` storage category, then the same fenced catalog transition records `DELETED`. The orphan-cleanup command first reconciles cataloged pending deletions and reports untracked objects; it deletes untracked objects only with the explicit `--delete-untracked` flag and after the grace period. Untracked scans consume bounded provider/catalog pages through the entire prefix, so a page containing only tracked or recent keys cannot starve later orphan keys. There is no automatic retention scheduler, legal-hold workflow, backup, or undelete UI.

## Verification

```bash
npm run test:documents
npm run test:integration
npm run typecheck
npm run lint
```

The document lane covers local/S3 storage behavior, containment and integrity, durable targeted cleanup and retry, contained legacy deletion, ClamAV protocol integration, fail-closed disposition, upload/scan/extract API-to-worker flow, archive/XML limits, PDF/DOCX/TXT/HTML/Markdown/CSV/JSON extraction, prompt-injection signals, and anchor invalidation. Normal tests use mocks or local containers and do not depend on a public network.
