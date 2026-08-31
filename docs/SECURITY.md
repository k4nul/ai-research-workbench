# Security

## Posture

v0.2 implements meaningful local controls for operator sessions, untrusted URLs/files/model text, project scoping, durable execution, private storage, malware scanning, export integrity, and audit history. It is still not approved for public or multi-tenant deployment. Minimal authentication is not authorization or tenancy.

Use synthetic or explicitly approved data until the deployment owner supplies TLS, managed secrets, network policy, authorization/tenant isolation, backup/restore, retention, monitoring, and incident response.

## Trust boundaries

| Input/subsystem | Treatment | Main controls |
| --- | --- | --- |
| Browser/API request | Untrusted | durable session, same-origin + CSRF for mutation, Zod/bounds, project scoping |
| Operator identity fields | Untrusted when supplied by HTTP | audit actor derived from authenticated principal; HTTP actor type ignored/rejected |
| Remote URL/DNS/redirect/body | Hostile | scheme/address policy, all-DNS-result validation, address pinning, redirect revalidation, time/byte/media limits |
| Uploaded bytes/metadata | Hostile | filename/extension/MIME/signature/size validation, quarantine, hash, fail-closed scan |
| PDF/DOCX/TXT/HTML/Markdown/CSV/JSON | Hostile | quarantine and scanning, bounded parsers, archive/XML/active-content restrictions, no external resource fetch |
| Source/model text | Untrusted data | sanitization, prompt-injection signals, explicit prompt boundary, source allowlist |
| Provider | External/possibly failing | timeout, abort, permit, schema, provenance, error classification, budgets |
| Worker | Fallible/replayable | leases, heartbeat, attempt fence, timeout, recovery, idempotent domain commit |
| Object storage | Private but fallible | contained keys/bucket, exclusive writes, byte/hash verification, bounded reads |
| Export content | Untrusted rendering data | escaping, CSV formula neutralization, current/approval gate, hash/size |
| PostgreSQL administrator | Privileged | outside the app threat boundary; audit rows are not tamper-evident |

## Authentication and CSRF

Passwords use Argon2id. Opaque session/CSRF tokens are random; only HMAC hashes are stored. Session cookies are HttpOnly and SameSite Strict; CSRF cookies are readable only so the client can echo the value in `x-csrf-token`. Unsafe API requests require a valid durable session, allowed origin, cookie/header equality, and stored CSRF hash.

Login failures use a PostgreSQL rate-limit record, generic credential error, and dummy password hash path. Password rotation revokes every active session and issues one replacement. Operators can list/revoke their sessions.

The proxy's cookie-presence check is only an early redirect. Services and the auth DAL enforce durable identity. Production rejects disabled auth, insecure cookies, missing/short session secret, and demo bypass. Bypass is restricted to non-production demo mode and loopback URL, bind, and request host.

There are no roles, per-project permissions, tenant isolation, MFA/SSO/recovery, admin UI, or cryptographic approver identity. See [Authentication](AUTHENTICATION.md).

## HTTP mutation replay

Every `POST`, `PUT`, `PATCH`, and `DELETE` requires a validated `Idempotency-Key`. Authenticated JSON routes hash the principal, method, pathname, raw query string, content type, and at most 4 MiB of request bytes. The receipt, domain writes, and audit writes commit in one PostgreSQL transaction; a concurrent or response-loss retry with the same input returns the exact stored JSON/status, while changed input returns `409`. Stored response JSON is also limited to 4 MiB.

Multipart document/source uploads use their bounded parser and verified file SHA-256 instead of central request buffering. Cookie-changing auth routes use dedicated receipts so successful login/password retries can reissue the same derived opaque cookies without storing raw passwords or tokens; revoked-session replay is allowed only for the matching completed receipt. These controls prevent duplicate application-domain commits covered by the transaction. They do not make external calls or at-least-once worker execution exactly once.

## URL fetch and SSRF

The safe fetch boundary:

- permits only HTTP(S);
- rejects credentials, localhost names, IPv6 zone identifiers, and literal private/local/reserved addresses;
- resolves the hostname and rejects it if any result is non-public or malformed;
- pins validated addresses into the connection;
- revalidates every redirect destination, detects loops, and bounds redirects;
- bounds the whole operation (10 seconds default, 30 seconds maximum);
- bounds streamed bytes (2 MiB default, 10 MB maximum);
- allowlists selected text/JSON/HTML media types on the active source route;
- sends no application cookies/credentials and uses a fixed user agent;
- records final/hop URLs, validated addresses, status, duration, and sanitization metadata.

This mitigates SSRF and rebinding but does not prove a public host is benign, licensed, factual, or safe to redistribute. Search snippets are not fetched automatically. Maintain the address-range policy as network standards change.

## Upload, scanning, and extraction

Upload validation normalizes filename, matches an allowlisted extension/MIME pair, verifies received size and basic signature, and privately quarantines bytes with SHA-256. Both upload URLs use the durable document pipeline for PDF, DOCX, TXT, HTML, Markdown, CSV, and JSON; there is no direct filesystem-upload fallback. Production requires fail-closed ClamAV; timeout/error/unavailable scanner blocks extraction, and infected content is rejected.

ClamAV is signature-based and not a guarantee. The mock scanner is a local fixture. The only scanner bypass requires explicit non-production demo configuration and is persisted/audited.

PDF extraction reads bounded text layers without running actions; textless documents require unsupported OCR. DOCX extraction rejects unsafe paths, archive bombs, excessive XML, DTD/entities, macros, ActiveX, embeddings, and external relationships. TXT, Markdown, CSV, and JSON use bounded text extraction, with JSON syntax checked before quarantine. HTML is sanitized and does not load resources. See [Document pipeline](DOCUMENT_PIPELINE.md) for exact limits.

## Prompt injection and provider output

External HTML is sanitized with explicit tags/attributes/schemes and safe link `rel` values. Extracted text/chunks are scored for instruction override, role reassignment, secret exfiltration, system-prompt probes, tool execution, jailbreak markers, and model control tokens.

Heuristics are a review signal with false positives/negatives. Provider prompts explicitly say source content is untrusted and cannot issue instructions. Structured output is parsed and source references must belong to the stage allowlist. No provider output grants workflow approval or QA authority.

## Durable execution

The worker queue is at least once, not exactly once. Jobs use project-scoped idempotency keys and canonical input hashes; stage attempts additionally use generation and worker/attempt fences plus transactional domain-commit keys/output hashes. Expired leases are retried/dead-lettered, and stale workers cannot commit after ownership changes.

These controls do not prevent an external provider from seeing/billing a duplicate request around a crash. Stable provider client request IDs and execution history support reconciliation. Cancellation is cooperative and does not prove upstream cancellation.

## Storage and exports

Local storage rejects unsafe keys/buckets, verifies real paths below the root, refuses symlink/non-regular file reads/deletes, uses exclusive `0600` files and `0700` directories, bounds reads, and verifies hashes. S3 uses one configured private bucket, conditional writes, metadata hash, head/read verification, and bounded signed URL TTL.

The deployment must configure encryption, IAM, lifecycle, replication, object lock/legal hold, backups, and restore. Artifact SHA-256 is an integrity value, not a digital signature. Material project changes mark exports non-current; final ZIP remains approval and QA-blocker gated.

Generated HTML escapes content. CSV output quotes fields and neutralizes spreadsheet formula prefixes. PDF/DOCX/ZIP structures are parsed in tests, but visual/office compatibility needs target-environment inspection.

## Database, audit, and destructive actions

Services use parameterized values and transactions; foreign keys/checks constrain core state. Project-scoped mutations load/lock the project and reject cross-project identifiers. State-changing workflow/operator actions append audit rows using principal-derived user or bounded system actors.

Audit events are mutable PostgreSQL records, not append-only storage enforced against administrators, a hash chain, or an external SIEM. Job events, provider executions, and domain commits supply complementary provenance.

`db:reset`, project/document deletion, orphan cleanup with deletion, session revocation, password rotation, and cancellation/retry are material operations. Use their explicit guard/confirmation and preserve evidence. There is no soft-delete/undelete or automatic backup.

## Secrets and external data

- Keep `.env`, runtime storage, evaluation output, provider responses, and delivery artifacts out of source control.
- Use `npm run validate:secrets` as a hygiene check, not a complete secret scanner.
- Inject provider/storage/session secrets through an approved secret manager and rotate them.
- Never include keys/tokens in prompts, source content, URLs, audit state, fixtures, logs, screenshots, or support bundles.
- OpenAI requests set `store: false`, but provider terms/account settings/regional controls still require review.
- Brave receives search queries. Live canaries use only synthetic inputs and are separate from normal CI.

## Known production blockers

- roles, workspace/project authorization, tenant isolation, MFA/SSO/recovery, and approver policy;
- HTTPS/HSTS, trusted proxy/origin policy, managed secrets, database TLS, network/egress controls;
- distributed HTTP rate limiting/abuse protection and provider billing reconciliation;
- backups/PITR/restore drills, retention/legal hold, object encryption/IAM/lifecycle;
- external/tamper-evident audit/security logs, metrics export, alerting, tracing, incident response;
- dependency/container/infrastructure vulnerability management;
- broader accessibility, browser, load, chaos, and disaster-recovery evidence;
- OCR and a reviewed policy for complex/active documents.

See [Limitations](LIMITATIONS.md) and [Roadmap](ROADMAP.md).

## Reporting a vulnerability

Do not put exploit details, credentials, or customer data in a public issue. Stop using the affected deployment and contact the repository owner's private security channel. If none is configured, establish a private channel before disclosure.
