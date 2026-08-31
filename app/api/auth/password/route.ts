import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin } from "@/lib/auth/csrf";
import { requestAuthTokens, requestClientContext } from "@/lib/auth/request";
import { deriveOpaqueToken, hashOpaqueToken } from "@/lib/auth/session";
import { setAuthCookies } from "@/lib/auth/session";
import { noStoreJsonHeaders, routeErrorResponse } from "@/lib/http";
import {
  requestQueryScope,
  requestIdempotencyKey
} from "@/lib/operations/request";
import {
  changeOperatorPasswordOutcome,
  requireAuthMutationContext
} from "@/lib/services/auth";
import { executeIdempotentResponse } from "@/lib/services/mutation-receipts";

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(1_024),
  newPassword: z.string().min(12).max(1_024)
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const input = passwordSchema.parse(await request.json());
    const tokens = requestAuthTokens(request);
    const context = await requireAuthMutationContext(tokens);
    const idempotencyKey = requestIdempotencyKey(request);
    const replacementTokens = {
      sessionToken: deriveOpaqueToken(
        `password-session\0${context.operatorId}\0${idempotencyKey}`
      ),
      csrfToken: deriveOpaqueToken(
        `password-csrf\0${context.operatorId}\0${idempotencyKey}`
      )
    };
    const receipt = await executeIdempotentResponse(
      {
        principalScope: `operator:${context.operatorId}`,
        method: "PATCH",
        requestPath: new URL(request.url).pathname,
        idempotencyKey,
        requestHash: hashOpaqueToken(
          `auth-password-v1\0${requestQueryScope(request)}\0${JSON.stringify(input)}`
        )
      },
      async () => {
        const outcome = await changeOperatorPasswordOutcome({
          ...tokens,
          ...requestClientContext(request),
          ...input,
          replacementTokens
        });
        if (outcome.kind === "invalid-current") {
          return {
            responseStatus: 401,
            responseBody: JSON.stringify({
              error: {
                code: "INVALID_CURRENT_PASSWORD",
                message: "The current password is invalid."
              }
            })
          };
        }
        if (outcome.kind === "reused") {
          return {
            responseStatus: 409,
            responseBody: JSON.stringify({
              error: {
                code: "PASSWORD_REUSE",
                message: "The new password must be different."
              }
            })
          };
        }
        const replacement = outcome.replacement;
        return {
          responseStatus: 200,
          responseBody: JSON.stringify({
            data: {
              operator: replacement.operator,
              session: {
                id: replacement.sessionId,
                expiresAt: replacement.expiresAt.toISOString()
              }
            }
          })
        };
      }
    );
    const response = new NextResponse(receipt.responseBody, {
      status: receipt.responseStatus,
      headers: { ...noStoreJsonHeaders(), "Content-Type": "application/json" }
    });
    if (receipt.responseStatus === 200) {
      const payload = JSON.parse(receipt.responseBody) as {
        data: { session: { expiresAt: string } };
      };
      setAuthCookies(response, {
        ...replacementTokens,
        expiresAt: new Date(payload.data.session.expiresAt)
      });
    }
    return response;
  } catch (error) {
    return routeErrorResponse(error);
  }
}
