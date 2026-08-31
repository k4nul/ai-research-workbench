# Authentication

## Implemented boundary

v0.2 provides minimal named-operator authentication for a single controlled installation:

- operators are provisioned from the command line; there is no public signup;
- passwords use Argon2id and must contain 12–1,024 characters;
- usernames are normalized case-insensitively and restricted to 3–64 safe characters;
- sessions use random 32-byte opaque tokens; only HMAC-SHA-256 token hashes are stored;
- the session cookie is `HttpOnly`, `SameSite=Strict`, path `/`, and secure according to configuration;
- a separate readable CSRF cookie is compared to the `x-csrf-token` header and its stored hash;
- unsafe requests require same-origin validation and CSRF verification;
- sessions expire, can be listed and revoked, and update last-seen at a bounded cadence;
- password change verifies the current password, rejects reuse, revokes all active sessions, and issues one replacement session;
- login failures are rate-limited in PostgreSQL and use a dummy hash path to reduce username enumeration signals;
- login, logout, password change, session revocation, and operator bootstrap append audit events.

The Next.js proxy performs an early cookie-presence redirect for navigation. It is not the authorization boundary. Page data access and API routes load the durable session and active operator from PostgreSQL through the data-access layer.

## Create the first operator

After migrations:

```bash
npm run operator:create
```

The command prompts for username, optional display name, password, and confirmation without accepting secrets on the command line. For a controlled non-interactive bootstrap, set `OPERATOR_USERNAME` and optional `OPERATOR_DISPLAY_NAME`, then pipe two matching password lines on standard input. Avoid shell history, process arguments, logs, and CI output.

Operator creation is idempotent only in the sense that a duplicate normalized username is rejected; it does not update an existing operator. There is no operator administration UI.

## Session endpoints

| Method and route | Purpose |
| --- | --- |
| `POST /api/auth/login` | Verify credentials, enforce database-backed login throttling, issue session and CSRF cookies |
| `GET /api/auth/session` | Return the current authenticated operator/session |
| `POST /api/auth/logout` | Revoke the current session and clear cookies |
| `PATCH /api/auth/password` | Change password, revoke all sessions, issue a replacement |
| `GET /api/auth/sessions` | List up to 100 active sessions for the current operator |
| `DELETE /api/auth/sessions/:sessionId` | Revoke one session owned by the current operator |

The Sessions page exposes listing, password change, logout, and revocation. Every auth mutation, including login, requires a validated `Idempotency-Key`. Authenticated mutations also require cookies, an allowed `Origin`, and `x-csrf-token` equal to the CSRF cookie.

Login, logout, password change, and session revocation use durable mutation receipts because their responses also manage cookies. A retry of a successful login or password change reissues the same HMAC-derived opaque cookie values and stored expiry without creating another session or audit event. A retry of a failed login/password check replays the same bounded error and does not count the same logical attempt twice; a new idempotency key is a new rate-limit attempt. Logout and current-session revocation can replay through the receipt after the original session was revoked, while a new-key mutation with that revoked session still fails authentication.

Browser clients retain generated keys by method, URL, and serialized JSON body after transport loss or an incomplete response, including overlapping attempts. They rotate the key when input changes or after any complete HTTP response, so a persisted `401`, `409`, or `429` does not become a permanent client-side replay. Explicitly supplied keys are preserved. Raw session/CSRF tokens and passwords are never stored in mutation receipts.

## Trusted mutation actor

Authenticated route handlers derive the audit actor from the durable request principal. Operator identity is not accepted from JSON. Legacy request fields such as `actorType` cannot turn an HTTP caller into a system actor. In the explicit local demo bypass, services use a clearly labeled demo fallback; worker actions use bounded system identities tied to jobs/services.

Audit rows store actor type and display label rather than a cryptographic signature. They are useful operational history, but the table is mutable by a database administrator and is not a tamper-evident identity ledger.

## Demo bypass

`AUTH_DEMO_BYPASS=true` exists only for explicit local fixtures. It is accepted only when:

- `DEMO_MODE=true`;
- `NODE_ENV` is not `production`;
- `APP_URL` uses `localhost`, `127.0.0.1`, or `[::1]`;
- `APP_BIND_HOST` is loopback;
- the incoming Next.js request host is loopback.

The runtime emits a warning and the health response reports `bypassed-local`. Production rejects disabled auth or any bypass. A loopback check is defense in depth, not permission to use the bypass with sensitive data.

## Production configuration checks

At runtime, production requires:

- `AUTH_ENABLED=true`;
- `AUTH_DEMO_BYPASS=false`;
- `AUTH_COOKIE_SECURE=true`;
- a nonblank `AUTH_SESSION_SECRET` of at least 32 characters.

Use a cryptographically random secret from a managed secret store and rotate it through a planned session invalidation. Terminate HTTPS before the application, preserve the intended origin, and configure trusted proxy behavior explicitly. The repository does not supply TLS or a secret manager.

## Authentication is not tenancy

The implementation has no roles, permissions, workspace membership enforcement, project ACLs, approver role, per-tenant database policy, storage tenant boundary, MFA, SSO, account recovery, invitation flow, admin lifecycle, or service-account model. Any authenticated operator can reach the application's operator routes and project data.

Workspace/client/project fields organize research; they do not authorize access. Project-ID checks prevent accidental cross-project record mutation inside the shared installation, but they do not isolate hostile tenants. Do not expose v0.2 as a multi-tenant or public service.

## Security and operational limits

- Login throttling and idempotent failure receipts are durable and shared through PostgreSQL, but general route rate limiting remains per-process and trusts proxy-derived client information where used.
- Same-origin checks allow a missing `Origin` outside production for local CLI/testing compatibility; production mutations require it.
- `SameSite=Strict` reduces cross-site cookie sending but does not replace the double-submit CSRF check.
- Session tokens in cookies are bearer credentials. Browser storage, logs, traces, and support bundles must not capture them.
- A development-only HMAC fallback exists when no session secret is configured outside production. Set a real secret for any persistent or shared environment.
- Deactivating operators has no documented UI/runbook in v0.2; direct database manipulation is not an endorsed administration API.
- Audit display labels can change between operations and are not digital signatures.

## Verification

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

Coverage includes password/session primitives, invalid credentials and lockout, response-loss replay for login/logout/password/session cookies and audit effects, browser key retention/rotation, CSRF and origin denial, session expiry/revocation, password rotation, loopback-only bypass validation, authenticated navigation, named operator audit attribution, and rejection of spoofed HTTP actor types. It does not prove roles, tenant isolation, SSO/MFA, reverse-proxy correctness, or production incident recovery because those capabilities are not implemented.
