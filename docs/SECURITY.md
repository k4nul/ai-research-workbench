# Security

## Security posture

The current application is a local single-user MVP. Its content-processing controls are meaningful, but it is not suitable for a public or multi-tenant production deployment. There is no login, session, authorization middleware, tenant isolation, or cryptographic approver identity. Workspace, client classification, and actor-label fields are domain metadata, not access controls.

Use only synthetic or explicitly approved local research data until the production checklist in [Deployment](DEPLOYMENT.md) is complete.

## Trust boundaries

| Input or subsystem | Trust assumption | Implemented control |
| --- | --- | --- |
| HTTP JSON | Untrusted | Zod schemas, field-specific bounds where defined, normalized errors |
| PostgreSQL | Locally controlled, but content remains untrusted for rendering | Parameterized values, transactions, FK/check constraints |
| Remote URLs and DNS | Hostile | Protocol/address validation, DNS validation and pinning, redirect revalidation |
| Remote response body | Hostile | Time/byte/media-type limits, HTML sanitization, prompt-injection assessment |
| Uploaded file metadata/bytes | Hostile | Filename, extension, MIME, byte count, signature, and limited content checks |
| Search/model output | Untrusted suggestion | Strict schemas, source-ID allowlist, prompt boundary, human verification |
| Generated HTML/CSV/files | Potential formula/rendering/content risk | HTML escaping, CSV quoting and formula-prefix neutralization, private paths, restrictive modes; artifact review remains required |
| Local user | Trusted operator | Audit labels and confirmations only; no identity proof |

## SSRF and remote-fetch controls

`lib/security/url.ts` implements a bounded safe-fetch boundary:

- accepts only `http:` and `https:`;
- rejects URL credentials, localhost names, IPv6 zone identifiers, and literal private/local/reserved addresses;
- resolves hostnames and rejects the request if any result is non-public or malformed;
- pins the validated address set into the HTTP connection to reduce DNS rebinding risk;
- follows only HTTP redirect statuses and revalidates every destination;
- detects redirect loops and limits redirects (default 3, maximum 10);
- bounds the whole operation (default 10 seconds, maximum 30 seconds);
- bounds response bytes (default 2 MiB, maximum 10 MB), including streaming reads;
- allowlists JSON, PDF, XHTML, CSV, HTML, Markdown, and plain-text responses by default; the active fetch route narrows this to JSON/XHTML/CSV/HTML/Markdown/plain text and excludes PDF;
- uses a fixed, validated user agent and sends no application credentials or cookies;
- returns hop URLs, resolved addresses, status, final URL, fetch time, and sanitization metadata.

HTML is sanitized before text extraction. Text is assessed with heuristic indicators for instruction override, role reassignment, secret extraction, system-prompt probing, tool execution, jailbreak markers, and model-control tokens.

Limitations:

- The safe fetcher is exposed through a local source-ingestion route; without authentication, that route must not be placed on an untrusted network.
- It does not establish that a public host is benign, licensed for use, accurate, or safe to distribute.
- IP-range policy and DNS pinning need periodic security review.
- PDF and other binary responses are bounded but not parsed or malware-scanned by this utility.

## File-validation controls

`lib/security/files.ts` recognizes these exact extension/MIME combinations:

| Extension | Accepted media type |
| --- | --- |
| `.csv` | `text/csv` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.htm`, `.html` | `text/html` |
| `.json` | `application/json` |
| `.md` | `text/markdown`, `text/plain` |
| `.pdf` | `application/pdf` |
| `.txt` | `text/plain` |

Validation requires actual bytes and checks declared size against received bytes. The default ceiling is 5 MiB. Filenames are reduced to a leaf name, normalized with NFKC, stripped of control/bidirectional path-confusing characters, bounded to 120 characters, and protected against Windows reserved names. PDF begins with `%PDF-`; DOCX has a ZIP-container signature; text contains no NUL byte; JSON must be valid UTF-8 JSON.

This is an allowlist and basic signature boundary, not a content-disarm pipeline. The multipart route privately stores validated files. It does not confirm a complete PDF/DOCX structure, unzip and inspect DOCX relationships, extract PDF/DOCX text, detect active content, scan malware, or enforce archive expansion limits.

## Content and prompt-injection controls

External HTML is sanitized with an explicit research-tag allowlist. Only `http`, `https`, and `mailto` link schemes are retained; protocol-relative URLs are disabled; link attributes are bounded and `rel="noopener noreferrer nofollow"` is forced. Export HTML separately escapes report titles and section content.

Provider prompts explicitly label source content as untrusted data and forbid following embedded instructions or using unapproved source IDs. Prompt-injection detection is heuristic and can have false positives/negatives. A flag is a review signal, not safe execution authority.

## API and browser controls

- Request bodies are validated and unexpected failures return a generic error with a random reference.
- Dynamic JSON and export responses use no-store/nosniff headers where implemented.
- Global headers include `X-Content-Type-Options`, frame denial, strict-origin referrer policy, a restrictive permissions policy, and a CSP limited to self/data with inline scripts/styles currently allowed for Next/application compatibility.
- Research-plan generation, explicit AI pipeline calls, and source search/fetch/upload use in-memory per-scope/client buckets.

The rate limiter trusts the first `X-Forwarded-For` value and stores buckets in one process. It is not a production control behind untrusted proxies or multiple replicas. There is no CSRF token/origin policy beyond same-origin browser defaults and CSP, because no session/auth model exists. There is no request-wide body-size enforcement for route-handler JSON beyond individual schemas; the configured 5 MB limit applies to Server Actions. The multipart route calls `request.formData()` before inspecting `File.size`, so a deployment proxy must enforce an upload request limit before the application reads the body.

## Database, audit, and deletion

Application SQL uses parameterized values for user-provided data; controlled dynamic identifiers appear in migration/reset helpers and allowlisted export formats. Multi-record workflow changes use transactions. Foreign keys and checks constrain relationships and state values.

Audit events record actor type/label, action, resource, before/after state, and time. They are ordinary mutable PostgreSQL rows and are not cryptographically chained, write-once, or exported to an external log.

`DELETE /api/projects/:projectId` and the reset script are destructive. Project deletion commits the database cascade first and then removes only validated project upload/export directories. Cleanup failure is globally audited and returned as an error, but it does not restore the deleted database row. The reset script requires `ALLOW_DATABASE_RESET=true` and truncates application tables. The application has no soft delete, restore UI, retention worker, or backup automation.

## Secrets and provider data

- Keep `.env` out of version control.
- Do not put keys in provider input, source content, audit snapshots, fixture data, URLs, or screenshots.
- Demo mode is the default and avoids live provider transfer.
- The OpenAI adapter sets `store: false`, but deployment owners must still review current provider terms, regional/data controls, and account settings.
- The Brave adapter sends the query and configured locale/freshness parameters to Brave.
- Key masking in diagnostics reduces accidental display; it is not a secret manager.

## Known gaps before production

- Authentication, session security, authorization, approver identity, and tenant isolation.
- CSRF design and trusted reverse-proxy/IP configuration.
- Managed TLS, secrets, database credentials, network policy, and provider egress policy.
- Distributed rate limiting, quotas, cost controls, and abuse monitoring.
- Malware scanning, robust PDF/DOCX parsing, archive-bomb defense, upload quarantine, and content retention.
- Backup/restore drills, soft deletion, legal hold, data export/deletion policy, and log retention.
- External/tamper-evident audit logging and operational alerting.
- Dependency, container, and infrastructure vulnerability management.
- End-to-end tests proving auth and approval cannot be bypassed.

Strict blocker semantics must remain covered end to end: QA, progress, approval, and final export treat every blocker whose status is not `RESOLVED` as blocking, including `ACCEPTED_RISK`, and downstream approval is invalidated after material research changes.

## Reporting a vulnerability

Do not place exploit details, provider keys, or customer data in public issues. Use the repository owner's private security-reporting channel. If no such channel is configured, stop using the affected deployment and contact the owner directly before disclosing details.
