import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "violet";

export type Severity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";

const statusToneByValue: Record<string, BadgeTone> = {
  ACTIVE: "success",
  APPROVED: "success",
  ARCHIVED: "neutral",
  BLOCKED: "warning",
  CANCELLATION_REQUESTED: "warning",
  CANCELLED: "neutral",
  CLAIMED: "info",
  COMPLETED: "success",
  CONTESTED: "warning",
  DEAD_LETTER: "danger",
  DELIVERED: "success",
  DRAFT: "neutral",
  FAILED: "danger",
  INTAKE: "neutral",
  NOT_VERIFIABLE: "danger",
  NOT_RUN_NO_CREDENTIALS: "warning",
  OUTDATED: "warning",
  PARTIALLY_SUPPORTED: "warning",
  PASSED: "success",
  PAUSED: "warning",
  PLANNING: "info",
  QA: "violet",
  QUEUED: "info",
  READY: "success",
  RESEARCHING: "info",
  RETRY_WAIT: "warning",
  RUNNING: "info",
  SCOPING: "info",
  STALE: "danger",
  SUCCEEDED: "success",
  SUPPORTED: "success",
  SYNTHESIZING: "violet",
  UNSUPPORTED: "danger",
  APPROVAL_REQUIRED: "warning",
};

const severityToneByValue: Record<Severity, BadgeTone> = {
  BLOCKER: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

function humanize(value: string) {
  return value
    .trim()
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

export function getStatusTone(status: string): BadgeTone {
  return statusToneByValue[status.trim().toLocaleUpperCase()] ?? "neutral";
}

interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: string;
  children?: ReactNode;
  tone?: BadgeTone;
  showDot?: boolean;
}

export function StatusBadge({
  status,
  children,
  tone = getStatusTone(status),
  showDot = true,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={["status-badge", className].filter(Boolean).join(" ")}
      data-tone={tone}
      {...props}
    >
      {showDot ? <span aria-hidden="true" className="status-badge__dot" /> : null}
      <span>{children ?? humanize(status)}</span>
    </span>
  );
}

interface SeverityBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  severity: Severity;
}

export function SeverityBadge({ severity, className, ...props }: SeverityBadgeProps) {
  return (
    <span
      className={["status-badge", "severity-badge", className]
        .filter(Boolean)
        .join(" ")}
      data-tone={severityToneByValue[severity]}
      {...props}
    >
      <span aria-hidden="true" className="status-badge__dot" />
      <span>{severity}</span>
    </span>
  );
}
