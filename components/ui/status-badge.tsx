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
  CONTESTED: "warning",
  DELIVERED: "success",
  DRAFT: "neutral",
  FAILED: "danger",
  INTAKE: "neutral",
  NOT_VERIFIABLE: "danger",
  OUTDATED: "warning",
  PARTIALLY_SUPPORTED: "warning",
  PAUSED: "warning",
  PLANNING: "info",
  QA: "violet",
  RESEARCHING: "info",
  SCOPING: "info",
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
