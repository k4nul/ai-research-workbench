import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  requireAuthenticatedApiRequest,
  type RequestPrincipal
} from "@/lib/auth/dal";
import { structuredLog } from "@/lib/observability/log";
import {
  requestQueryScope,
  requestIdempotencyKey
} from "@/lib/operations/request";
import { AppError } from "@/lib/services/errors";
import { executeIdempotentMutation } from "@/lib/services/mutation-receipts";
import { formatValidationError } from "@/lib/validation";

const MAX_CENTRAL_MUTATION_BODY_BYTES = 4 * 1_024 * 1_024;

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function principalScope(principal: RequestPrincipal): string {
  return principal.kind === "operator"
    ? `operator:${principal.session.operator.id}`
    : "demo-bypass";
}

async function boundedMutationBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    throw new AppError(
      500,
      "IDEMPOTENCY_MODE_REQUIRED",
      "Multipart mutations must use a dedicated bounded idempotency implementation."
    );
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength && /^\d+$/u.test(rawLength) && Number(rawLength) > MAX_CENTRAL_MUTATION_BODY_BYTES) {
    throw new AppError(
      413,
      "MUTATION_BODY_TOO_LARGE",
      "The mutation body exceeds the idempotency receipt limit."
    );
  }
  if (!request.body) return new Uint8Array();

  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CENTRAL_MUTATION_BODY_BYTES) {
        const reason = "Mutation body exceeded its configured bound.";
        void reader.cancel(reason).catch(() => undefined);
        void request.body.cancel(reason).catch(() => undefined);
        throw new AppError(
          413,
          "MUTATION_BODY_TOO_LARGE",
          "The mutation body exceeds the idempotency receipt limit."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function mutationRequestHash(request: Request): Promise<string> {
  const hash = createHash("sha256");
  hash.update(requestQueryScope(request));
  hash.update("\0");
  hash.update(request.headers.get("content-type")?.toLowerCase() ?? "");
  hash.update("\0");
  hash.update(await boundedMutationBody(request));
  return hash.digest("hex");
}

export async function handleRoute<T>(
  operation: () => Promise<T>,
  options: { status?: number } = {}
): Promise<NextResponse> {
  try {
    const data = await operation();
    return NextResponse.json(
      { data },
      { status: options.status ?? 200, headers: noStoreJsonHeaders() }
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function handleAuthenticatedRoute<T>(
  request: Request,
  operation: (principal: RequestPrincipal) => Promise<T>,
  options: {
    status?: number;
    mutation?: boolean;
    idempotency?: "central" | "dedicated";
  } = {}
): Promise<NextResponse> {
  try {
    const mutation = options.mutation ?? isUnsafeMethod(request.method);
    const principal = await requireAuthenticatedApiRequest(request, {
      mutation
    });
    if (!mutation || options.idempotency === "dedicated") {
      return NextResponse.json(
        { data: await operation(principal) },
        { status: options.status ?? 200, headers: noStoreJsonHeaders() }
      );
    }

    const method = request.method.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new AppError(
        500,
        "IDEMPOTENCY_METHOD_UNSUPPORTED",
        "This mutation method does not have an idempotency receipt implementation."
      );
    }
    const receipt = await executeIdempotentMutation(
      {
        principalScope: principalScope(principal),
        method: method as "POST" | "PUT" | "PATCH" | "DELETE",
        requestPath: new URL(request.url).pathname,
        idempotencyKey: requestIdempotencyKey(request),
        requestHash: await mutationRequestHash(request)
      },
      options.status ?? 200,
      () => operation(principal)
    );
    return new NextResponse(receipt.responseBody, {
      status: receipt.responseStatus,
      headers: { ...noStoreJsonHeaders(), "Content-Type": "application/json" }
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export function routeErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: formatValidationError(error) },
      { status: 400, headers: noStoreJsonHeaders() }
    );
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } },
      { status: 400, headers: noStoreJsonHeaders() }
    );
  }
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      { status: error.status, headers: noStoreJsonHeaders() }
    );
  }
  const reference = crypto.randomUUID();
  structuredLog("error", "http.request_failed", {
    service: "web",
    requestId: reference,
    errorCode: error instanceof Error ? error.name : "UNKNOWN"
  });
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        reference
      }
    },
    { status: 500, headers: noStoreJsonHeaders() }
  );
}

type RateBucket = {
  count: number;
  resetAt: number;
};

const rateBuckets = new Map<string, RateBucket>();

export function enforceRateLimit(
  request: Request,
  scope: string,
  limit = 20,
  windowMs = 60_000
): void {
  const forwarded = request.headers.get("x-forwarded-for");
  const client = forwarded?.split(",")[0]?.trim() || "local";
  const key = scope + ":" + client;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many requests. Wait before retrying.",
      { retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1_000) }
    );
  }
  bucket.count += 1;
}

export function noStoreJsonHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
}
