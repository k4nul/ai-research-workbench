import type { NextRequest } from "next/server";

import {
  AUTH_CSRF_COOKIE,
  AUTH_CSRF_HEADER,
  AUTH_SESSION_COOKIE
} from "@/lib/auth/constants";

export function requestAuthTokens(request: NextRequest): {
  sessionToken?: string;
  csrfCookie?: string;
  csrfHeader: string | null;
} {
  return {
    sessionToken: request.cookies.get(AUTH_SESSION_COOKIE)?.value,
    csrfCookie: request.cookies.get(AUTH_CSRF_COOKIE)?.value,
    csrfHeader: request.headers.get(AUTH_CSRF_HEADER)
  };
}

export function requestClientContext(request: Request): {
  userAgent: string | null;
  clientAddress: string | null;
} {
  return {
    userAgent: request.headers.get("user-agent"),
    clientAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}
