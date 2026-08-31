import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import {
  assertCsrfToken,
  assertSameOrigin,
  safeRedirectPath,
  timingSafeStringEqual
} from "@/lib/auth/csrf";
import {
  hashOperatorPassword,
  normalizeOperatorUsername,
  operatorPasswordNeedsRehash,
  verifyOperatorPassword
} from "@/lib/auth/password";
import {
  loginRetryAfterSeconds,
  normalizeLoginRateLimitState,
  registerLoginFailure
} from "@/lib/auth/rate-limit";
import { validateAuthRuntime } from "@/lib/auth/runtime";
import {
  clearAuthCookies,
  createOpaqueToken,
  hashOpaqueToken,
  setAuthCookies
} from "@/lib/auth/session";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operator password and token security", () => {
  it("normalizes usernames and hashes passwords with Argon2id", async () => {
    expect(normalizeOperatorUsername("  Fixture.Operator  ")).toBe("fixture.operator");
    const hash = await hashOperatorPassword("correct horse battery fixture");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain("correct horse battery fixture");
    await expect(
      verifyOperatorPassword(hash, "correct horse battery fixture")
    ).resolves.toBe(true);
    await expect(verifyOperatorPassword(hash, "wrong password" )).resolves.toBe(false);
    expect(operatorPasswordNeedsRehash(hash)).toBe(false);
  });

  it("creates opaque tokens and stable one-way references", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(hashOpaqueToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(first)).not.toContain(first);
  });

  it("keys stored token references and uses only the explicit non-production fallback", () => {
    const fallback = hashOpaqueToken("fixture-token", { NODE_ENV: "test" });
    expect(hashOpaqueToken("fixture-token", { NODE_ENV: "development" })).toBe(
      fallback
    );
    expect(
      hashOpaqueToken("fixture-token", {
        NODE_ENV: "production",
        AUTH_SESSION_SECRET: "a".repeat(32)
      })
    ).not.toBe(fallback);
    expect(() =>
      hashOpaqueToken("fixture-token", { NODE_ENV: "production" })
    ).toThrow("required in production");
  });
});

describe("CSRF and redirect boundaries", () => {
  it("uses constant-length timing-safe token comparisons", () => {
    expect(timingSafeStringEqual("fixture-token", "fixture-token")).toBe(true);
    expect(timingSafeStringEqual("fixture-token", "other")).toBe(false);
    expect(() =>
      assertCsrfToken(
        hashOpaqueToken("fixture-token"),
        "fixture-token",
        "fixture-token"
      )
    ).not.toThrow();
    expect(() =>
      assertCsrfToken(hashOpaqueToken("fixture-token"), "fixture-token", "wrong")
    ).toThrowError(expect.objectContaining({ code: "CSRF_INVALID" }));
  });

  it("rejects cross-origin mutations and external redirect targets", () => {
    expect(() =>
      assertSameOrigin(
        new Request("http://localhost:3100/api/auth/login", {
          headers: { origin: "https://attacker.invalid" }
        })
      )
    ).toThrowError(expect.objectContaining({ code: "ORIGIN_MISMATCH" }));
    expect(safeRedirectPath("/projects?status=QA")).toBe("/projects?status=QA");
    expect(safeRedirectPath("https://attacker.invalid")).toBe("/");
    expect(safeRedirectPath("//attacker.invalid")).toBe("/");
    expect(safeRedirectPath("/safe\\..\\unsafe")).toBe("/");
  });
});

describe("auth cookie and runtime policy", () => {
  it("sets opaque strict cookies and clears both values", () => {
    const response = NextResponse.json({ ok: true });
    const expiresAt = new Date(Date.now() + 60_000);
    setAuthCookies(response, {
      sessionToken: "session-fixture",
      csrfToken: "csrf-fixture",
      expiresAt
    });
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain("HttpOnly");
    expect(
      setCookies.every((cookie) => cookie.toLowerCase().includes("samesite=strict"))
    ).toBe(true);

    const cleared = NextResponse.json({ ok: true });
    clearAuthCookies(cleared);
    expect(cleared.headers.getSetCookie().every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("permits only explicit loopback demo bypass and rejects unsafe production", () => {
    expect(
      validateAuthRuntime({
        NODE_ENV: "development",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        APP_URL: "http://127.0.0.1:3100"
      }).warning
    ).toContain("bypassed");
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "development",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        APP_URL: "https://research.example.com"
      })
    ).toThrow("loopback");
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "development",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        APP_URL: "http://127.0.0.1:3100",
        APP_BIND_HOST: "0.0.0.0"
      })
    ).toThrow("loopback bind host");
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "production",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        AUTH_COOKIE_SECURE: "true",
        AUTH_SESSION_SECRET: "production-session-secret-at-least-32-characters",
        APP_URL: "https://research.example.com"
      })
    ).toThrow("forbidden in production");
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "production",
        DEMO_MODE: "false",
        AUTH_ENABLED: "false",
        AUTH_DEMO_BYPASS: "false",
        AUTH_COOKIE_SECURE: "true",
        AUTH_SESSION_SECRET: "production-session-secret-at-least-32-characters",
        APP_URL: "https://research.example.com"
      })
    ).toThrow("AUTH_ENABLED");
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "production",
        DEMO_MODE: "false",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "false",
        AUTH_COOKIE_SECURE: "true",
        AUTH_SESSION_SECRET: "too-short",
        APP_URL: "https://research.example.com"
      })
    ).toThrow("AUTH_SESSION_SECRET");
  });

  it("rejects non-loopback requests even when a loopback demo URL is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("AUTH_ENABLED", "true");
    vi.stubEnv("AUTH_DEMO_BYPASS", "true");
    vi.stubEnv("APP_URL", "http://127.0.0.1:3100");
    vi.stubEnv("APP_BIND_HOST", "127.0.0.1");

    const denied = proxy(new NextRequest("http://192.0.2.10:3100/projects"));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "AUTH_BYPASS_LOCAL_ONLY" }
    });
    expect(proxy(new NextRequest("http://127.0.0.1:3100/projects")).status).toBe(200);
  });
});

describe("login throttling", () => {
  const config = { maximumAttempts: 2, windowSeconds: 60, blockSeconds: 120 };
  const start = new Date("2026-08-30T00:00:00.000Z");

  it("resets expired windows and blocks at the configured threshold", () => {
    const initial = { attemptCount: 0, windowStartedAt: start, blockedUntil: null };
    const first = registerLoginFailure(initial, start, config);
    const second = registerLoginFailure(first, new Date(start.getTime() + 1_000), config);
    expect(first.attemptCount).toBe(1);
    expect(loginRetryAfterSeconds(second, new Date(start.getTime() + 1_000))).toBe(120);

    const reset = normalizeLoginRateLimitState(
      second,
      new Date(start.getTime() + 121_000),
      config
    );
    expect(reset).toMatchObject({ attemptCount: 0, blockedUntil: null });
  });
});
