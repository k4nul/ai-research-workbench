import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/services/errors";
import { formatValidationError } from "@/lib/validation";

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
  console.error("Unhandled request error", { reference, error });
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
