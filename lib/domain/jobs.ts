export const JOB_STATUSES = [
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "RETRY_WAIT",
  "CANCELLATION_REQUESTED",
  "CANCELLED",
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTER"
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_ERROR_CLASSES = [
  "RETRYABLE_PROVIDER_RATE_LIMIT",
  "RETRYABLE_PROVIDER_SERVER_ERROR",
  "RETRYABLE_NETWORK",
  "RETRYABLE_STORAGE",
  "RETRYABLE_TIMEOUT",
  "NON_RETRYABLE_VALIDATION",
  "NON_RETRYABLE_SECURITY",
  "NON_RETRYABLE_BUDGET",
  "NON_RETRYABLE_USER_INPUT",
  "CANCELLED",
  "UNKNOWN"
] as const;

export type JobErrorClass = (typeof JOB_ERROR_CLASSES)[number];

export type JobRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export const DEFAULT_JOB_RETRY_POLICY: JobRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2
};

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ["CLAIMED", "CANCELLED"],
  CLAIMED: [
    "RUNNING",
    "RETRY_WAIT",
    "CANCELLATION_REQUESTED",
    "CANCELLED",
    "FAILED",
    "DEAD_LETTER"
  ],
  RUNNING: [
    "SUCCEEDED",
    "RETRY_WAIT",
    "CANCELLATION_REQUESTED",
    "CANCELLED",
    "FAILED",
    "DEAD_LETTER"
  ],
  RETRY_WAIT: ["CLAIMED", "QUEUED", "CANCELLED"],
  CANCELLATION_REQUESTED: ["CANCELLED"],
  CANCELLED: [],
  SUCCEEDED: [],
  FAILED: ["QUEUED"],
  DEAD_LETTER: ["QUEUED"]
};

const retryableErrors = new Set<JobErrorClass>([
  "RETRYABLE_PROVIDER_RATE_LIMIT",
  "RETRYABLE_PROVIDER_SERVER_ERROR",
  "RETRYABLE_NETWORK",
  "RETRYABLE_STORAGE",
  "RETRYABLE_TIMEOUT",
  "UNKNOWN"
]);

export class InvalidJobTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus
  ) {
    super(`Job cannot transition from ${from} to ${to}.`);
    this.name = "InvalidJobTransitionError";
  }
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new InvalidJobTransitionError(from, to);
  }
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return ["CANCELLED", "SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(status);
}

export function isRetryableJobError(errorClass: JobErrorClass): boolean {
  return retryableErrors.has(errorClass);
}

function finiteInteger(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export function parseJobRetryPolicy(value: unknown): JobRetryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Retry policy must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const baseDelayMs = finiteInteger(candidate.baseDelayMs, "baseDelayMs", 1);
  const maxDelayMs = finiteInteger(candidate.maxDelayMs, "maxDelayMs", baseDelayMs);
  const jitterRatio = candidate.jitterRatio;
  if (
    typeof jitterRatio !== "number" ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1
  ) {
    throw new Error("jitterRatio must be between 0 and 1.");
  }
  return { baseDelayMs, maxDelayMs, jitterRatio };
}

export function calculateRetryDelayMs(input: {
  attempt: number;
  policy: JobRetryPolicy;
  retryAfterMs?: number;
  random?: () => number;
}): number {
  const attempt = finiteInteger(input.attempt, "attempt", 1);
  const policy = parseJobRetryPolicy(input.policy);
  const random = input.random ?? Math.random;
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new Error("random must return a number between 0 and 1.");
  }
  if (
    input.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)
  ) {
    throw new Error("retryAfterMs must be a non-negative safe integer.");
  }

  const exponent = Math.min(attempt - 1, 30);
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** exponent
  );
  const jitterMultiplier =
    1 - policy.jitterRatio + randomValue * policy.jitterRatio * 2;
  const jittered = Math.max(0, Math.round(exponential * jitterMultiplier));
  return Math.max(jittered, input.retryAfterMs ?? 0);
}

export function failureJobStatus(input: {
  errorClass: JobErrorClass;
  attempts: number;
  maxAttempts: number;
}): "RETRY_WAIT" | "FAILED" | "DEAD_LETTER" {
  const attempts = finiteInteger(input.attempts, "attempts", 1);
  const maxAttempts = finiteInteger(input.maxAttempts, "maxAttempts", 1);
  if (!isRetryableJobError(input.errorClass)) {
    return "FAILED";
  }
  return attempts < maxAttempts ? "RETRY_WAIT" : "DEAD_LETTER";
}

export function sanitizeJobError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 2_000) || "Unspecified job error";
}
