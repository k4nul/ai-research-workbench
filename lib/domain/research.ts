export const WORKFLOW_GATES = [
  "scopeConfirmed",
  "planApproved",
  "questionsResearched",
  "claimsLinkedToEvidence",
  "reportWritten",
  "qaPassed",
  "humanApproved",
  "deliverablesGenerated"
] as const;

export type WorkflowGate = (typeof WORKFLOW_GATES)[number];
export type WorkflowGateState = Record<WorkflowGate, boolean>;

export function calculateWorkflowProgress(gates: WorkflowGateState): number {
  const completed = WORKFLOW_GATES.filter((gate) => gates[gate] === true).length;
  return Math.round((completed / WORKFLOW_GATES.length) * 100);
}

export type SourceFreshnessStatus = "CURRENT" | "AGING" | "OUTDATED" | "UNKNOWN";
export type DateInput = Date | string;

const MILLISECONDS_PER_DAY = 86_400_000;
const AGING_THRESHOLD_RATIO = 0.8;

function utcDay(value: DateInput, label: string): number {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`${label} must be a valid date`);
    }
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM-DD`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = Date.UTC(year, month - 1, day);
  const parsedDate = new Date(parsed);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid date`);
  }
  return parsed;
}

export interface SourceFreshnessInput {
  publishedAt?: DateInput | null;
  researchDate: DateInput;
  maxAgeDays: number;
}

export function assessSourceFreshness({
  publishedAt,
  researchDate,
  maxAgeDays
}: SourceFreshnessInput): SourceFreshnessStatus {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new RangeError("maxAgeDays must be a non-negative integer");
  }
  if (publishedAt === null || publishedAt === undefined) {
    return "UNKNOWN";
  }

  const publishedDay = utcDay(publishedAt, "publishedAt");
  const researchDay = utcDay(researchDate, "researchDate");
  const ageDays = (researchDay - publishedDay) / MILLISECONDS_PER_DAY;

  if (ageDays < 0) {
    return "UNKNOWN";
  }
  if (ageDays > maxAgeDays) {
    return "OUTDATED";
  }
  if (
    maxAgeDays > 0 &&
    ageDays >= Math.ceil(maxAgeDays * AGING_THRESHOLD_RATIO)
  ) {
    return "AGING";
  }
  return "CURRENT";
}

export type EvidenceRelationship = "SUPPORTS" | "REFUTES" | "CONTEXT";
export type EvidenceVerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";
export type EvidenceSupportExtent = "FULL" | "PARTIAL";
export type ClaimSupportStatus =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "CONTESTED"
  | "UNSUPPORTED"
  | "OUTDATED"
  | "NOT_VERIFIABLE";

export interface ClaimEvidenceAssessment {
  relationship: EvidenceRelationship;
  verificationStatus: EvidenceVerificationStatus;
  sourceFreshness: SourceFreshnessStatus;
  supportExtent?: EvidenceSupportExtent;
}

export interface ClaimSupportInput {
  evidence: readonly ClaimEvidenceAssessment[];
  verificationPossible?: boolean;
}

export function calculateClaimSupportStatus({
  evidence,
  verificationPossible = true
}: ClaimSupportInput): ClaimSupportStatus {
  if (!verificationPossible) {
    return "NOT_VERIFIABLE";
  }

  const verified = evidence.filter(
    (item) =>
      item.verificationStatus === "VERIFIED" && item.relationship !== "CONTEXT"
  );
  const supporting = verified.filter((item) => item.relationship === "SUPPORTS");
  const refuting = verified.filter((item) => item.relationship === "REFUTES");

  if (supporting.length > 0 && refuting.length > 0) {
    return "CONTESTED";
  }
  if (supporting.length === 0) {
    return "UNSUPPORTED";
  }
  if (supporting.every((item) => item.sourceFreshness === "OUTDATED")) {
    return "OUTDATED";
  }

  const hasFullUsableSupport = supporting.some(
    (item) =>
      (item.supportExtent ?? "FULL") === "FULL" &&
      (item.sourceFreshness === "CURRENT" || item.sourceFreshness === "AGING")
  );
  return hasFullUsableSupport ? "SUPPORTED" : "PARTIALLY_SUPPORTED";
}

export type CitationIdIssueCode = "MALFORMED" | "DUPLICATE" | "UNKNOWN";

export interface CitationIdIssue {
  code: CitationIdIssueCode;
  index: number;
  citationId: string | null;
}

const CITATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isCitationId(value: unknown): value is string {
  return typeof value === "string" && CITATION_ID_PATTERN.test(value);
}

export function findCitationIdIssues(
  citationIds: readonly unknown[],
  knownCitationIds: Iterable<string>
): CitationIdIssue[] {
  const known = new Set(knownCitationIds);
  const seen = new Set<string>();
  const issues: CitationIdIssue[] = [];

  citationIds.forEach((value, index) => {
    if (!isCitationId(value)) {
      issues.push({
        code: "MALFORMED",
        index,
        citationId: typeof value === "string" ? value : null
      });
      return;
    }

    if (seen.has(value)) {
      issues.push({ code: "DUPLICATE", index, citationId: value });
    } else {
      seen.add(value);
    }
    if (!known.has(value)) {
      issues.push({ code: "UNKNOWN", index, citationId: value });
    }
  });

  return issues;
}

export class CitationIdValidationError extends Error {
  readonly issues: readonly CitationIdIssue[];

  constructor(issues: readonly CitationIdIssue[]) {
    super("citation IDs failed validation");
    this.name = "CitationIdValidationError";
    this.issues = issues;
  }
}

export function validateCitationIds(
  citationIds: readonly unknown[],
  knownCitationIds: Iterable<string>
): string[] {
  const issues = findCitationIdIssues(citationIds, knownCitationIds);
  if (issues.length > 0) {
    throw new CitationIdValidationError(issues);
  }
  return citationIds.slice() as string[];
}

export type ResearchGapStatus = "NONE" | "OPEN" | "ACCEPTED" | "RESOLVED";

export interface ResearchGapState {
  gapStatus: ResearchGapStatus;
}

export function countOpenResearchGaps(gaps: readonly ResearchGapState[]): number {
  return gaps.filter((gap) => gap.gapStatus === "OPEN").length;
}
