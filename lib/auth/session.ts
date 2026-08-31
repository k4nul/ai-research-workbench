import { createHmac, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { AUTH_CSRF_COOKIE, AUTH_SESSION_COOKIE } from "@/lib/auth/constants";

const TOKEN_BYTES = 32;
const DEVELOPMENT_SESSION_SECRET =
  "ai-research-workbench-development-only-session-hmac-key-v1";

export function createOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function sessionHashSecret(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.AUTH_SESSION_SECRET?.trim()
    ? environment.AUTH_SESSION_SECRET
    : undefined;
  if (configured && configured.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters.");
  }
  if (configured) return configured;
  if (environment.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET is required in production.");
  }
  return DEVELOPMENT_SESSION_SECRET;
}

export function hashOpaqueToken(
  token: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return createHmac("sha256", sessionHashSecret(environment))
    .update(token, "utf8")
    .digest("hex");
}

export function deriveOpaqueToken(
  purpose: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const derived = createHmac("sha256", sessionHashSecret(environment))
    .update("ai-research-workbench-derived-token-v1\0", "utf8")
    .update(purpose, "utf8")
    .digest();
  return derived.toString("base64url");
}

export function sanitizeClientLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, 200) : null;
}

export function fingerprintClient(value: string | null): string | null {
  const normalized = sanitizeClientLabel(value);
  return normalized ? hashOpaqueToken(normalized) : null;
}

export function authCookieSecure(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.AUTH_COOKIE_SECURE === "true") return true;
  if (environment.AUTH_COOKIE_SECURE === "false") return false;
  return environment.NODE_ENV === "production";
}

function cookieBase(expires: Date, httpOnly: boolean) {
  return {
    expires,
    httpOnly,
    maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1_000)),
    path: "/",
    priority: "high" as const,
    sameSite: "strict" as const,
    secure: authCookieSecure()
  };
}

export function setAuthCookies(
  response: NextResponse,
  values: { sessionToken: string; csrfToken: string; expiresAt: Date }
): void {
  response.cookies.set(
    AUTH_SESSION_COOKIE,
    values.sessionToken,
    cookieBase(values.expiresAt, true)
  );
  response.cookies.set(
    AUTH_CSRF_COOKIE,
    values.csrfToken,
    cookieBase(values.expiresAt, false)
  );
}

export function clearAuthCookies(response: NextResponse): void {
  const expired = new Date(0);
  response.cookies.set(AUTH_SESSION_COOKIE, "", cookieBase(expired, true));
  response.cookies.set(AUTH_CSRF_COOKIE, "", cookieBase(expired, false));
}
