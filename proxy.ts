import { NextRequest, NextResponse } from "next/server";

import { AUTH_SESSION_COOKIE } from "@/lib/auth/constants";
import { safeRedirectPath } from "@/lib/auth/csrf";
import { isLoopbackHost, validateAuthRuntime } from "@/lib/auth/runtime";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/session",
  "/api/health"
]);

export function proxy(request: NextRequest): NextResponse {
  const runtime = validateAuthRuntime();
  if (runtime.demoAuthBypass) {
    if (!isLoopbackHost(request.nextUrl.hostname)) {
      return NextResponse.json(
        { error: { code: "AUTH_BYPASS_LOCAL_ONLY", message: "Demo authentication bypass is local-only." } },
        {
          status: 403,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
        }
      );
    }
    return NextResponse.next();
  }
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  if (request.cookies.has(AUTH_SESSION_COOKIE)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } },
      {
        status: 401,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
      }
    );
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set(
    "next",
    safeRedirectPath(`${request.nextUrl.pathname}${request.nextUrl.search}`)
  );
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"
  ]
};
