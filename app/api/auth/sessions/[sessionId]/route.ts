import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin } from "@/lib/auth/csrf";
import { requestAuthTokens } from "@/lib/auth/request";
import { clearAuthCookies } from "@/lib/auth/session";
import { noStoreJsonHeaders, routeErrorResponse } from "@/lib/http";
import { hashOpaqueToken } from "@/lib/auth/session";
import {
  requestQueryScope,
  requestIdempotencyKey
} from "@/lib/operations/request";
import { requireAuthMutationContext, revokeOperatorSession } from "@/lib/services/auth";
import { executeIdempotentMutation } from "@/lib/services/mutation-receipts";

type Context = { params: Promise<{ sessionId: string }> };

const sessionIdSchema = z.string().uuid();

export async function DELETE(
  request: NextRequest,
  context: Context
): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const { sessionId } = await context.params;
    const targetSessionId = sessionIdSchema.parse(sessionId);
    const tokens = requestAuthTokens(request);
    const authContext = await requireAuthMutationContext(tokens);
    const receipt = await executeIdempotentMutation(
      {
        principalScope: `operator:${authContext.operatorId}:session:${authContext.sessionId}`,
        method: "DELETE",
        requestPath: new URL(request.url).pathname,
        idempotencyKey: requestIdempotencyKey(request),
        requestHash: hashOpaqueToken(
          `auth-session-revoke-v1\0${requestQueryScope(request)}\0${targetSessionId}`
        )
      },
      200,
      async () => {
        const result = await revokeOperatorSession({
          ...tokens,
          targetSessionId
        });
        return { revoked: true, sessionId: targetSessionId, ...result };
      }
    );
    const payload = JSON.parse(receipt.responseBody) as {
      data: { revokedCurrentSession: boolean };
    };
    const response = new NextResponse(receipt.responseBody, {
      status: receipt.responseStatus,
      headers: { ...noStoreJsonHeaders(), "Content-Type": "application/json" }
    });
    if (payload.data.revokedCurrentSession) {
      clearAuthCookies(response);
    }
    return response;
  } catch (error) {
    return routeErrorResponse(error);
  }
}
