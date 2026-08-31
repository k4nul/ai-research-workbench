import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { GET as dashboardRoute } from "@/app/api/dashboard/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { PATCH as passwordRoute } from "@/app/api/auth/password/route";
import { GET as sessionRoute } from "@/app/api/auth/session/route";
import { DELETE as revokeSessionRoute } from "@/app/api/auth/sessions/[sessionId]/route";
import { PUT as deliverableRoute } from "@/app/api/projects/[projectId]/deliverable/route";
import { POST as projectsRoute } from "@/app/api/projects/route";
import { proxy } from "@/proxy";
import { hashOpaqueToken } from "@/lib/auth/session";
import { closePool, getPool, query } from "@/lib/db";
import {
  authenticateOperator,
  changeOperatorPassword,
  createOperator,
  getAuthenticatedOperatorSession,
  listOperatorSessions,
  revokeOperatorSession
} from "@/lib/services/auth";
import { resetTestDatabase } from "@/tests/helpers/database";

const originalRateLimitAttempts = process.env.AUTH_LOGIN_MAX_ATTEMPTS;
const loopbackUrl = "http://localhost:3100";

beforeEach(async () => {
  process.env.AUTH_LOGIN_MAX_ATTEMPTS = "3";
  await resetTestDatabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (originalRateLimitAttempts === undefined) {
    delete process.env.AUTH_LOGIN_MAX_ATTEMPTS;
  } else {
    process.env.AUTH_LOGIN_MAX_ATTEMPTS = originalRateLimitAttempts;
  }
  await closePool();
});

async function fixtureOperator() {
  return createOperator({
    username: "fixture.operator",
    displayName: "Fixture Operator",
    password: "correct horse battery fixture"
  });
}

function authMutationRequest(
  pathName: string,
  method: "POST" | "PATCH" | "DELETE",
  session: { sessionToken: string; csrfToken: string },
  idempotencyKey: string,
  body?: unknown
): NextRequest {
  return new NextRequest(`${loopbackUrl}${pathName}`, {
    method,
    headers: {
      cookie: `arw_session=${session.sessionToken}; arw_csrf=${session.csrfToken}`,
      origin: loopbackUrl,
      "x-csrf-token": session.csrfToken,
      "idempotency-key": idempotencyKey,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function responseCookie(response: NextResponse, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.startsWith(`${name}=`));
}

describe("operator authentication persistence", () => {
  it("applies the additive auth migration repeatedly", async () => {
    const migration = await readFile(
      path.join(process.cwd(), "migrations", "007_operator_auth.sql"),
      "utf8"
    );
    await getPool().query(migration);
    await getPool().query(migration);
    const tables = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [["operators", "operator_sessions", "operator_login_rate_limits"]]
    );
    expect(new Set(tables.rows.map((row) => row.table_name))).toEqual(
      new Set(["operators", "operator_sessions", "operator_login_rate_limits"])
    );
  });

  it("stores only Argon2 and opaque-token hashes and writes login audit events", async () => {
    const operator = await fixtureOperator();
    const session = await authenticateOperator({
      username: "FIXTURE.OPERATOR",
      password: "correct horse battery fixture",
      userAgent: "Auth integration fixture",
      clientAddress: "127.0.0.1"
    });
    expect(session.operator.id).toBe(operator.id);

    const storedOperator = await query<{ password_hash: string }>(
      "SELECT password_hash FROM operators WHERE id = $1",
      [operator.id]
    );
    const storedSession = await query<{
      token_hash: string;
      csrf_token_hash: string;
      client_fingerprint: string;
    }>(
      "SELECT token_hash, csrf_token_hash, client_fingerprint FROM operator_sessions WHERE id = $1",
      [session.sessionId]
    );
    expect(storedOperator.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(storedOperator.rows[0].password_hash).not.toContain("correct horse");
    expect(storedSession.rows[0]).toMatchObject({
      token_hash: hashOpaqueToken(session.sessionToken),
      csrf_token_hash: hashOpaqueToken(session.csrfToken),
      client_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(storedSession.rows[0].token_hash).not.toBe(session.sessionToken);
    expect(
      Number(
        (
          await query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM audit_events WHERE action IN ('OPERATOR_CREATED', 'OPERATOR_LOGIN_SUCCEEDED')"
          )
        ).rows[0].count
      )
    ).toBe(2);
  });

  it("rate-limits invalid credentials without revealing operator existence", async () => {
    await fixtureOperator();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        authenticateOperator({
          username: "fixture.operator",
          password: "incorrect fixture password"
        })
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    }
    await expect(
      authenticateOperator({
        username: "fixture.operator",
        password: "incorrect fixture password"
      })
    ).rejects.toMatchObject({ code: "LOGIN_RATE_LIMITED", status: 429 });
    await expect(
      authenticateOperator({
        username: "fixture.operator",
        password: "correct horse battery fixture"
      })
    ).rejects.toMatchObject({ code: "LOGIN_RATE_LIMITED", status: 429 });

    const limit = await query<{ key_hash: string; blocked_until: Date | null }>(
      "SELECT key_hash, blocked_until FROM operator_login_rate_limits"
    );
    expect(limit.rows).toHaveLength(1);
    expect(limit.rows[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(limit.rows[0].blocked_until).toBeInstanceOf(Date);
  });

  it("requires CSRF, rotates on password change, and revokes owned sessions", async () => {
    await fixtureOperator();
    const first = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture",
      userAgent: "First client"
    });
    const second = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture",
      userAgent: "Second client"
    });
    expect((await listOperatorSessions(first.sessionToken)).sessions).toHaveLength(2);

    await expect(
      revokeOperatorSession({
        sessionToken: first.sessionToken,
        csrfCookie: first.csrfToken,
        csrfHeader: "wrong-token",
        targetSessionId: second.sessionId
      })
    ).rejects.toMatchObject({ code: "CSRF_INVALID", status: 403 });
    await revokeOperatorSession({
      sessionToken: first.sessionToken,
      csrfCookie: first.csrfToken,
      csrfHeader: first.csrfToken,
      targetSessionId: second.sessionId
    });
    expect(await getAuthenticatedOperatorSession(second.sessionToken)).toBeNull();

    const replacement = await changeOperatorPassword({
      sessionToken: first.sessionToken,
      csrfCookie: first.csrfToken,
      csrfHeader: first.csrfToken,
      currentPassword: "correct horse battery fixture",
      newPassword: "replacement horse battery fixture",
      userAgent: "Replacement client"
    });
    expect(await getAuthenticatedOperatorSession(first.sessionToken)).toBeNull();
    expect(await getAuthenticatedOperatorSession(replacement.sessionToken)).not.toBeNull();
    await expect(
      authenticateOperator({
        username: "fixture.operator",
        password: "correct horse battery fixture"
      })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      authenticateOperator({
        username: "fixture.operator",
        password: "replacement horse battery fixture"
      })
    ).resolves.toMatchObject({ operator: { username: "fixture.operator" } });
  });

  it("sets secure response cookies and resolves the authenticated session API", async () => {
    await fixtureOperator();
    const loginRequest = () =>
      new NextRequest("http://localhost:3100/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "login-response-loss-fixture",
          origin: "http://localhost:3100",
          "user-agent": "Route fixture"
        },
        body: JSON.stringify({
          username: "fixture.operator",
          password: "correct horse battery fixture"
        })
      });
    const login = await loginRoute(loginRequest());
    expect(login.status).toBe(200);
    const loginBody = await login.text();
    const setCookies = login.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies.some((value) => value.includes("arw_session=") && value.includes("HttpOnly"))).toBe(true);
    expect(setCookies.some((value) => value.includes("arw_csrf=") && !value.includes("HttpOnly"))).toBe(true);

    const replay = await loginRoute(loginRequest());
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(loginBody);
    expect(responseCookie(replay, "arw_session")).toBe(responseCookie(login, "arw_session"));
    expect(responseCookie(replay, "arw_csrf")).toBe(responseCookie(login, "arw_csrf"));
    await expect(
      query<{ sessions: number; audits: number; receipts: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM operator_sessions) AS sessions,
          (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'OPERATOR_LOGIN_SUCCEEDED') AS audits,
          (SELECT COUNT(*)::integer FROM mutation_receipts WHERE request_path = '/api/auth/login') AS receipts`
      )
    ).resolves.toMatchObject({ rows: [{ sessions: 1, audits: 1, receipts: 1 }] });

    const cookieHeader = setCookies.map((value) => value.split(";")[0]).join("; ");
    const current = await sessionRoute(
      new NextRequest("http://localhost:3100/api/auth/session", {
        headers: { cookie: cookieHeader }
      })
    );
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      data: {
        authenticated: true,
        operator: { username: "fixture.operator" },
        session: { id: expect.any(String), expiresAt: expect.any(String) }
      }
    });
  });

  it("replays failed login attempts without weakening rate-limit accounting", async () => {
    await fixtureOperator();
    const request = (key: string) =>
      new NextRequest(`${loopbackUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          origin: loopbackUrl
        },
        body: JSON.stringify({
          username: "fixture.operator",
          password: "incorrect fixture password"
        })
      });

    const first = await loginRoute(request("login-failure-one"));
    const firstBody = await first.text();
    expect(first.status).toBe(401);
    const replay = await loginRoute(request("login-failure-one"));
    expect(replay.status).toBe(401);
    expect(await replay.text()).toBe(firstBody);
    expect((await loginRoute(request("login-failure-two"))).status).toBe(401);
    expect((await loginRoute(request("login-failure-three"))).status).toBe(429);

    await expect(
      query<{ attempts: number; audits: number; receipts: number }>(
        `SELECT
          (SELECT attempt_count FROM operator_login_rate_limits LIMIT 1) AS attempts,
          (SELECT COUNT(*)::integer FROM audit_events WHERE action IN ('OPERATOR_LOGIN_FAILED', 'OPERATOR_LOGIN_RATE_LIMITED')) AS audits,
          (SELECT COUNT(*)::integer FROM mutation_receipts WHERE request_path = '/api/auth/login') AS receipts`
      )
    ).resolves.toMatchObject({ rows: [{ attempts: 3, audits: 3, receipts: 3 }] });
  });

  it("replays password rotation with the same replacement cookies and one audit effect", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);
    await fixtureOperator();
    const session = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture"
    });
    const key = "password-response-loss-fixture";
    const body = {
      currentPassword: "correct horse battery fixture",
      newPassword: "replacement horse battery fixture"
    };

    const deniedBody = { ...body, currentPassword: "incorrect fixture password" };
    const denied = await passwordRoute(
      authMutationRequest(
        "/api/auth/password",
        "PATCH",
        session,
        "password-denied-response-loss",
        deniedBody
      )
    );
    const deniedResponseBody = await denied.text();
    expect(denied.status).toBe(401);
    const deniedReplay = await passwordRoute(
      authMutationRequest(
        "/api/auth/password",
        "PATCH",
        session,
        "password-denied-response-loss",
        deniedBody
      )
    );
    expect(deniedReplay.status).toBe(401);
    expect(await deniedReplay.text()).toBe(deniedResponseBody);

    const first = await passwordRoute(
      authMutationRequest("/api/auth/password", "PATCH", session, key, body)
    );
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const firstSessionCookie = responseCookie(first, "arw_session");
    const firstCsrfCookie = responseCookie(first, "arw_csrf");
    expect(firstSessionCookie).toMatch(/^arw_session=[A-Za-z0-9_-]{43}$/);
    expect(firstCsrfCookie).toMatch(/^arw_csrf=[A-Za-z0-9_-]{43}$/);

    const replay = await passwordRoute(
      authMutationRequest("/api/auth/password", "PATCH", session, key, body)
    );
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(responseCookie(replay, "arw_session")).toBe(firstSessionCookie);
    expect(responseCookie(replay, "arw_csrf")).toBe(firstCsrfCookie);

    const drift = await passwordRoute(
      authMutationRequest("/api/auth/password", "PATCH", session, key, {
        ...body,
        newPassword: "different replacement battery fixture"
      })
    );
    expect(drift.status).toBe(409);
    await expect(drift.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
    await expect(
      query<{
        version: number;
        active_sessions: number;
        audits: number;
        denials: number;
        receipts: number;
      }>(
        `SELECT
          (SELECT password_version FROM operators WHERE normalized_username = 'fixture.operator') AS version,
          (SELECT COUNT(*)::integer FROM operator_sessions WHERE revoked_at IS NULL) AS active_sessions,
          (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'OPERATOR_PASSWORD_CHANGED') AS audits,
          (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'OPERATOR_PASSWORD_CHANGE_DENIED') AS denials,
          (SELECT COUNT(*)::integer FROM mutation_receipts WHERE request_path = '/api/auth/password') AS receipts`
      )
    ).resolves.toMatchObject({
      rows: [{ version: 2, active_sessions: 1, audits: 1, denials: 1, receipts: 2 }]
    });
  });

  it("replays logout and current-session revocation without duplicate audits", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);
    await fixtureOperator();
    const logoutSession = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture"
    });
    const logoutKey = "logout-response-loss-fixture";
    const firstLogout = await logoutRoute(
      authMutationRequest("/api/auth/logout", "POST", logoutSession, logoutKey)
    );
    const firstLogoutBody = await firstLogout.text();
    expect(firstLogout.status).toBe(200);
    expect(responseCookie(firstLogout, "arw_session")).toBe("arw_session=");
    const replayLogout = await logoutRoute(
      authMutationRequest("/api/auth/logout", "POST", logoutSession, logoutKey)
    );
    expect(replayLogout.status).toBe(200);
    expect(await replayLogout.text()).toBe(firstLogoutBody);
    expect(responseCookie(replayLogout, "arw_session")).toBe("arw_session=");

    const revokeSession = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture"
    });
    const revokePath = `/api/auth/sessions/${revokeSession.sessionId}`;
    const revokeKey = "session-revoke-response-loss-fixture";
    const context = { params: Promise.resolve({ sessionId: revokeSession.sessionId }) };
    const firstRevoke = await revokeSessionRoute(
      authMutationRequest(revokePath, "DELETE", revokeSession, revokeKey),
      context
    );
    const firstRevokeBody = await firstRevoke.text();
    expect(firstRevoke.status).toBe(200);
    expect(responseCookie(firstRevoke, "arw_session")).toBe("arw_session=");
    const replayRevoke = await revokeSessionRoute(
      authMutationRequest(revokePath, "DELETE", revokeSession, revokeKey),
      context
    );
    expect(replayRevoke.status).toBe(200);
    expect(await replayRevoke.text()).toBe(firstRevokeBody);
    expect(responseCookie(replayRevoke, "arw_session")).toBe("arw_session=");

    await expect(
      query<{ logouts: number; revocations: number; receipts: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'OPERATOR_LOGOUT') AS logouts,
          (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'OPERATOR_SESSION_REVOKED') AS revocations,
          (SELECT COUNT(*)::integer FROM mutation_receipts WHERE request_path LIKE '/api/auth/%') AS receipts`
      )
    ).resolves.toMatchObject({ rows: [{ logouts: 1, revocations: 1, receipts: 2 }] });
  });
});

describe("route authentication boundary", () => {
  it("rejects missing and forged sessions before returning protected data", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);

    const missing = await dashboardRoute(new Request(`${loopbackUrl}/api/dashboard`));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });

    const forged = await dashboardRoute(
      new Request(`${loopbackUrl}/api/dashboard`, {
        headers: { cookie: "arw_session=forged-session-token" }
      })
    );
    expect(forged.status).toBe(401);
    await expect(forged.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });
  });

  it("requires a matching double-submit CSRF token for mutations", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);
    await fixtureOperator();
    const session = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture"
    });
    const cookie = `arw_session=${session.sessionToken}; arw_csrf=${session.csrfToken}`;
    const withoutCsrf = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: { cookie, origin: loopbackUrl, "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(withoutCsrf.status).toBe(403);
    await expect(withoutCsrf.json()).resolves.toMatchObject({
      error: { code: "CSRF_INVALID" }
    });

    const forgedCsrf = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: {
          cookie,
          origin: loopbackUrl,
          "content-type": "application/json",
          "x-csrf-token": "forged-csrf-token"
        },
        body: "{}"
      })
    );
    expect(forgedCsrf.status).toBe(403);
    await expect(forgedCsrf.json()).resolves.toMatchObject({
      error: { code: "CSRF_INVALID" }
    });

    const crossOrigin = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://attacker.invalid",
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          "idempotency-key": "verified-csrf-fixture"
        },
        body: "{}"
      })
    );
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      error: { code: "ORIGIN_MISMATCH" }
    });

    const verified = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: {
          cookie,
          origin: loopbackUrl,
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          "idempotency-key": "verified-csrf-fixture"
        },
        body: "{}"
      })
    );
    expect(verified.status).toBe(400);
    await expect(verified.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
  });

  it("attributes mutations to the named operator and ignores a spoofed report actor type", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);
    await fixtureOperator();
    const session = await authenticateOperator({
      username: "fixture.operator",
      password: "correct horse battery fixture"
    });
    const headers = {
      cookie: `arw_session=${session.sessionToken}; arw_csrf=${session.csrfToken}`,
      origin: loopbackUrl,
      "content-type": "application/json",
      "x-csrf-token": session.csrfToken
    };
    const createdResponse = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": "trusted-project-create" },
        body: JSON.stringify({
          mode: "quick",
          name: "Trusted actor integration",
          coreQuestion: "Who performed this authenticated mutation?",
          purpose: "Verify trusted audit attribution.",
          audience: "Test operator",
          scope: "Authenticated audit actor propagation.",
          researchDate: "2026-08-31",
          sourceMaxAgeDays: 365,
          deliverableFormats: ["MARKDOWN"]
        })
      })
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { data: { id: string } };

    const updateResponse = await deliverableRoute(
      new Request(`${loopbackUrl}/api/projects/${created.data.id}/deliverable`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": "trusted-deliverable-update" },
        body: JSON.stringify({
          title: "Trusted actor report",
          sections: {},
          actorType: "AI"
        })
      }),
      { params: Promise.resolve({ projectId: created.data.id }) }
    );
    expect(updateResponse.status).toBe(200);

    const audit = await query<{
      action: string;
      actor_type: string;
      actor_label: string;
    }>(
      "SELECT action, actor_type, actor_label FROM audit_events WHERE project_id = $1 AND action = ANY($2::text[]) ORDER BY created_at",
      [created.data.id, ["PROJECT_CREATED", "DELIVERABLE_UPDATED"]]
    );
    expect(audit.rows).toEqual([
      {
        action: "PROJECT_CREATED",
        actor_type: "USER",
        actor_label: "Fixture Operator (fixture.operator)"
      },
      {
        action: "DELIVERABLE_UPDATED",
        actor_type: "USER",
        actor_label: "Fixture Operator (fixture.operator)"
      }
    ]);
    const revision = await query<{ actor_type: string }>(
      "SELECT r.actor_type FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE d.project_id = $1 ORDER BY r.created_at DESC LIMIT 1",
      [created.data.id]
    );
    expect(revision.rows[0]?.actor_type).toBe("USER");
  });

  it("keeps the same-origin mutation boundary in loopback demo bypass", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "true");
    vi.stubEnv("APP_URL", loopbackUrl);

    const crossOrigin = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      error: { code: "ORIGIN_MISMATCH" }
    });

    const sameOrigin = await projectsRoute(
      new Request(`${loopbackUrl}/api/projects`, {
        method: "POST",
        headers: {
          origin: loopbackUrl,
          "content-type": "application/json",
          "idempotency-key": "demo-same-origin-fixture"
        },
        body: "{}"
      })
    );
    expect(sameOrigin.status).toBe(400);
    await expect(sameOrigin.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
  });
});

describe("optimistic proxy boundary", () => {
  it("redirects protected UI and rejects APIs while leaving bootstrap paths public", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);

    const page = proxy(new NextRequest(`${loopbackUrl}/projects?status=QA`));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(
      `${loopbackUrl}/login?next=%2Fprojects%3Fstatus%3DQA`
    );

    const api = proxy(new NextRequest(`${loopbackUrl}/api/dashboard`));
    expect(api.status).toBe(401);
    await expect(api.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });

    expect(proxy(new NextRequest(`${loopbackUrl}/login`)).status).toBe(200);
    expect(proxy(new NextRequest(`${loopbackUrl}/api/health`)).status).toBe(200);
    expect(proxy(new NextRequest(`${loopbackUrl}/api/auth/session`)).status).toBe(200);
  });

  it("treats cookie presence as optimistic only and permits a valid loopback bypass", () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    vi.stubEnv("APP_URL", loopbackUrl);
    const forged = proxy(
      new NextRequest(`${loopbackUrl}/projects`, {
        headers: { cookie: "arw_session=forged-session-token" }
      })
    );
    expect(forged.headers.get("x-middleware-next")).toBe("1");

    vi.stubEnv("AUTH_DEMO_BYPASS", "true");
    expect(proxy(new NextRequest(`${loopbackUrl}/projects`)).status).toBe(200);
  });

  it("fails closed when bypass is configured for production or a public host", () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "true");
    vi.stubEnv("APP_URL", "https://research.example.com");
    expect(() => proxy(new NextRequest(`${loopbackUrl}/projects`))).toThrow("loopback");

    vi.stubEnv("APP_URL", loopbackUrl);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_COOKIE_SECURE", "true");
    vi.stubEnv("AUTH_SESSION_SECRET", "production-session-secret-at-least-32-characters");
    expect(() => proxy(new NextRequest(`${loopbackUrl}/projects`))).toThrow(
      "forbidden in production"
    );
  });
});
