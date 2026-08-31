import type { ProviderErrorClass } from "./types";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export class ProviderRequestError extends Error {
  readonly classification: ProviderErrorClass;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      classification: ProviderErrorClass;
      retryable: boolean;
      httpStatus?: number;
      retryAfterMs?: number;
      requestId?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.classification = options.classification;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  const value = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - now;
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(value)));
}

function rateLimitValues(
  headers: Headers,
  name: string
): Array<number | undefined> | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  return raw.split(",").map((value) => {
    const normalized = value.trim();
    if (!normalized) return undefined;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  });
}

export function braveResetMs(headers: Headers): number | undefined {
  const resets = rateLimitValues(headers, "x-ratelimit-reset");
  const first = resets?.[0];
  if (!resets || first === undefined) return undefined;

  const limits = rateLimitValues(headers, "x-ratelimit-limit");
  const remaining = rateLimitValues(headers, "x-ratelimit-remaining");
  const exhaustedResets = resets.flatMap((reset, index) => {
    const limit = limits?.[index];
    const available = remaining?.[index];
    return reset !== undefined &&
      limit !== undefined &&
      limit > 0 &&
      available !== undefined &&
      available <= 0
      ? [reset]
      : [];
  });
  const seconds = exhaustedResets.length > 0 ? Math.max(...exhaustedResets) : first;
  return Number.isFinite(seconds)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(seconds * 1_000)))
    : undefined;
}

export function composeAbortSignal(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal,
    timeoutSignal
  };
}

export function classifyFetchFailure(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): ProviderRequestError {
  if (externalSignal?.aborted) {
    return new ProviderRequestError("Provider request was cancelled", {
      classification: "CANCELLED",
      retryable: false,
      cause: error
    });
  }
  if (timeoutSignal.aborted) {
    return new ProviderRequestError("Provider request timed out", {
      classification: "RETRYABLE_NETWORK",
      retryable: true,
      cause: error
    });
  }
  return new ProviderRequestError("Provider network request failed", {
    classification: "RETRYABLE_NETWORK",
    retryable: true,
    cause: error
  });
}

export async function readJsonWithLimit(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ProviderRequestError("Provider response exceeded the byte limit", {
      classification: "NON_RETRYABLE_VALIDATION",
      retryable: false,
      httpStatus: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined
    });
  }
  if (!response.body) {
    throw new ProviderRequestError("Provider returned an empty response", {
      classification: "NON_RETRYABLE_VALIDATION",
      retryable: false,
      httpStatus: response.status
    });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ProviderRequestError("Provider response exceeded the byte limit", {
          classification: "NON_RETRYABLE_VALIDATION",
          retryable: false,
          httpStatus: response.status,
          requestId: response.headers.get("x-request-id") ?? undefined
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ProviderRequestError("Provider returned invalid JSON", {
      classification: "NON_RETRYABLE_VALIDATION",
      retryable: false,
      httpStatus: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      cause: error
    });
  }
}
