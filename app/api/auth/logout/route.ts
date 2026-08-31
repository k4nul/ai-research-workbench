import { NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "@/lib/auth/csrf";
import { requestAuthTokens } from "@/lib/auth/request";
import { clearAuthCookies } from "@/lib/auth/session";
import { noStoreJsonHeaders, routeErrorResponse } from "@/lib/http";
import { hashOpaqueToken } from "@/lib/auth/session";
import {
  requestQueryScope,
  requestIdempotencyKey
} from "@/lib/operations/request";
import { logoutOperator, requireAuthMutationContext } from "@/lib/services/auth";
import { executeIdempotentMutation } from "@/lib/services/mutation-receipts";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const tokens = requestAuthTokens(request);
    const context = await requireAuthMutationContext(tokens);
    const receipt = await executeIdempotentMutation(
      {
        principalScope: `operator:${context.operatorId}:session:${context.sessionId}`,
        method: "POST",
        requestPath: new URL(request.url).pathname,
        idempotencyKey: requestIdempotencyKey(request),
        requestHash: hashOpaqueToken(
          `auth-logout-v1\0${requestQueryScope(request)}`
        )
      },
      200,
      async () => {
        await logoutOperator(tokens);
        return { authenticated: false };
      }
    );
    const response = new NextResponse(receipt.responseBody, {
      status: receipt.responseStatus,
      headers: { ...noStoreJsonHeaders(), "Content-Type": "application/json" }
    });
    clearAuthCookies(response);
    return response;
  } catch (error) {
    return routeErrorResponse(error);
  }
}
