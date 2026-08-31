import { NextRequest } from "next/server";

import { AUTH_SESSION_COOKIE } from "@/lib/auth/constants";
import { handleRoute } from "@/lib/http";
import { listOperatorSessions } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleRoute(() =>
    listOperatorSessions(request.cookies.get(AUTH_SESSION_COOKIE)?.value)
  );
}
