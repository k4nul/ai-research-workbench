import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin } from "@/lib/auth/csrf";
import { normalizeOperatorUsername } from "@/lib/auth/password";
import { requestClientContext } from "@/lib/auth/request";
import { deriveOpaqueToken, hashOpaqueToken, setAuthCookies } from "@/lib/auth/session";
import { noStoreJsonHeaders, routeErrorResponse } from "@/lib/http";
import {
  requestIdempotencyKey,
  requestQueryScope
} from "@/lib/operations/request";
import { authenticateOperatorOutcome } from "@/lib/services/auth";
import { executeIdempotentResponse } from "@/lib/services/mutation-receipts";

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1_024)
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const input = loginSchema.parse(await request.json());
    const normalizedUsername = normalizeOperatorUsername(input.username);
    const idempotencyKey = requestIdempotencyKey(request);
    const replacementTokens = {
      sessionToken: deriveOpaqueToken(
        `login-session\0${normalizedUsername}\0${idempotencyKey}`
      ),
      csrfToken: deriveOpaqueToken(
        `login-csrf\0${normalizedUsername}\0${idempotencyKey}`
      )
    };
    const receipt = await executeIdempotentResponse(
      {
        principalScope: `login:${hashOpaqueToken(normalizedUsername)}`,
        method: "POST",
        requestPath: new URL(request.url).pathname,
        idempotencyKey,
        requestHash: hashOpaqueToken(
          `auth-login-v1\0${requestQueryScope(request)}\0${JSON.stringify(input)}`
        )
      },
      async () => {
        const outcome = await authenticateOperatorOutcome({
          ...input,
          ...requestClientContext(request),
          replacementTokens
        });
        if (outcome.kind === "invalid") {
          return {
            responseStatus: 401,
            responseBody: JSON.stringify({
              error: {
                code: "INVALID_CREDENTIALS",
                message: "The username or password is invalid."
              }
            })
          };
        }
        if (outcome.kind === "rate-limited") {
          return {
            responseStatus: 429,
            responseBody: JSON.stringify({
              error: {
                code: "LOGIN_RATE_LIMITED",
                message: "Too many login attempts. Try again later.",
                details: { retryAfterSeconds: outcome.retryAfterSeconds }
              }
            })
          };
        }
        const session = outcome.session;
        return {
          responseStatus: 200,
          responseBody: JSON.stringify({
            data: {
              operator: session.operator,
              session: {
                id: session.sessionId,
                expiresAt: session.expiresAt.toISOString()
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
