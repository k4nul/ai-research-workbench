import { NextRequest } from "next/server";

import { AUTH_SESSION_COOKIE } from "@/lib/auth/constants";
import { handleRoute } from "@/lib/http";
import { requireAuthenticatedOperatorSession } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleRoute(async () => {
    const session = await requireAuthenticatedOperatorSession(
      request.cookies.get(AUTH_SESSION_COOKIE)?.value
    );
    return {
      authenticated: true,
      operator: session.operator,
      session: { id: session.sessionId, expiresAt: session.expiresAt.toISOString() }
    };
  });
}
