import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  service: "web" | "worker" | "cli";
  workerId?: string;
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  jobType?: string;
  runId?: string;
  projectId?: string;
  stage?: string;
  provider?: string;
  durationMs?: number;
  retry?: number;
  errorCode?: string;
}

const identifierPattern = /^[A-Za-z0-9._:-]{1,256}$/;
const credentialAssignmentPattern = /(?:^|[._:-])(?:api[_-]?key|bearer|password|secret|token)[:=]/i;
const safeDetailKeys = new Set([
  "activeJobs",
  "count",
  "handlerCount",
  "httpStatus",
  "outcome",
  "queueLagMs",
  "status"
]);

function safeIdentifier(value: string | undefined): string | undefined {
  return value && identifierPattern.test(value) && !credentialAssignmentPattern.test(value)
    ? value
    : undefined;
}

function safeCorrelationIdentifier(value: string | undefined): string | undefined {
  const safe = safeIdentifier(value);
  if (safe) {
    return safe;
  }
  if (!value) {
    return undefined;
  }
  if (credentialAssignmentPattern.test(value)) {
    return "redacted";
  }
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function safeDetails(
  details: Readonly<Record<string, string | number | boolean | null>>
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!safeDetailKeys.has(key)) {
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      continue;
    }
    if (typeof value === "string") {
      const safe = safeIdentifier(value);
      if (safe) {
        result[key] = safe;
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function serializeStructuredLog(
  level: LogLevel,
  event: string,
  context: LogContext,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): string {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: context.service,
    event: safeIdentifier(event) ?? "invalid_event",
    workerId: safeIdentifier(context.workerId),
    requestId: safeCorrelationIdentifier(context.requestId),
    correlationId: safeCorrelationIdentifier(context.correlationId),
    jobId: safeIdentifier(context.jobId),
    jobType: safeIdentifier(context.jobType),
    runId: safeIdentifier(context.runId),
    projectId: safeIdentifier(context.projectId),
    stage: safeIdentifier(context.stage),
    provider: safeIdentifier(context.provider),
    durationMs:
      context.durationMs !== undefined && Number.isFinite(context.durationMs)
        ? Math.max(0, Math.round(context.durationMs))
        : undefined,
    retry:
      context.retry !== undefined && Number.isInteger(context.retry)
        ? Math.max(0, context.retry)
        : undefined,
    errorCode: safeIdentifier(context.errorCode),
    details: safeDetails(details)
  };
  return JSON.stringify(record) + "\n";
}

export function structuredLog(
  level: LogLevel,
  event: string,
  context: LogContext,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): void {
  const output = serializeStructuredLog(level, event, context, details);
  if (level === "error" || level === "warn") {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }
}
