import { createHash, timingSafeEqual } from "node:crypto";

import { hashOpaqueToken } from "@/lib/auth/session";
import { AppError } from "@/lib/services/errors";

function comparable(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(comparable(left), comparable(right));
}

export function assertCsrfToken(
  expectedHash: string,
  cookieToken: string | undefined,
  headerToken: string | null
): void {
  if (
    !cookieToken ||
    !headerToken ||
    !timingSafeStringEqual(cookieToken, headerToken) ||
    !timingSafeStringEqual(expectedHash, hashOpaqueToken(headerToken))
  ) {
    throw new AppError(403, "CSRF_INVALID", "The request could not be verified.");
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(403, "ORIGIN_REQUIRED", "The request origin is required.");
    }
    return;
  }

  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : requestOrigin;
  if (origin !== requestOrigin && origin !== configuredOrigin) {
    throw new AppError(403, "ORIGIN_MISMATCH", "The request origin is not allowed.");
  }
}

export function safeRedirectPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }
  return value;
}
