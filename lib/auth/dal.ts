import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AUTH_CSRF_COOKIE, AUTH_CSRF_HEADER, AUTH_SESSION_COOKIE } from "@/lib/auth/constants";
import { assertCsrfToken, assertSameOrigin } from "@/lib/auth/csrf";
import { validateAuthRuntime } from "@/lib/auth/runtime";
import {
  getAuthenticatedOperatorSession,
  requireAuthenticatedOperatorSession,
  type AuthenticatedOperatorSession
} from "@/lib/services/auth";

export type RequestPrincipal =
  | { kind: "operator"; session: AuthenticatedOperatorSession }
  | { kind: "demo-bypass" };

function requestCookie(request: Request, name: string): string | undefined {
  const entry = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return undefined;
  const value = entry.slice(name.length + 1);
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export async function requireAuthenticatedApiRequest(
  request: Request,
  options: { mutation?: boolean } = {}
): Promise<RequestPrincipal> {
  const runtime = validateAuthRuntime();
  const mutation = options.mutation ?? isUnsafeMethod(request.method);

  if (mutation) assertSameOrigin(request);
  if (runtime.demoAuthBypass) return { kind: "demo-bypass" };

  const csrfCookie = requestCookie(request, AUTH_CSRF_COOKIE);
  const session = await requireAuthenticatedOperatorSession(
    requestCookie(request, AUTH_SESSION_COOKIE)
  );
  if (mutation) {
    assertCsrfToken(
      session.csrfTokenHash,
      csrfCookie,
      request.headers.get(AUTH_CSRF_HEADER)
    );
  }
  return { kind: "operator", session };
}

export async function requirePageOperator(): Promise<RequestPrincipal> {
  const runtime = validateAuthRuntime();
  if (runtime.demoAuthBypass) return { kind: "demo-bypass" };

  const cookieStore = await cookies();
  const session = await getAuthenticatedOperatorSession(
    cookieStore.get(AUTH_SESSION_COOKIE)?.value
  );
  if (!session) redirect("/login");
  return { kind: "operator", session };
}
