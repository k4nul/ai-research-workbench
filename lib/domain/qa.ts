import {
  assessSourceFreshness,
  calculateClaimSupportStatus,
  countOpenResearchGaps,
  findCitationIdIssues,
  isCitationId,
  type DateInput,
  type EvidenceRelationship,
  type EvidenceSupportExtent,
  type EvidenceVerificationStatus,
  type ResearchGapState,
  type SourceFreshnessStatus
} from "./research";

export type QaSeverity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";
export type QaResolutionStatus = "OPEN" | "RESOLVED" | "ACCEPTED_RISK";

export const QA_RULE_DEFINITIONS = {
  UNSOURCED_KEY_CLAIM: { severity: "BLOCKER" },
  INVALID_CITATION_ID: { severity: "BLOCKER" },
  OUTDATED_SOURCE: { severity: "HIGH" },
  DUPLICATE_SOURCE: { severity: "MEDIUM" },
  SOURCE_CONCENTRATION: { severity: "HIGH" },
  UNRESOLVED_SOURCE_CONFLICT: { severity: "BLOCKER" },
  FACT_INFERENCE_MIX: { severity: "HIGH" },
  UNSUPPORTED_NUMBER: { severity: "BLOCKER" },
  DATE_OR_UNIT_MISMATCH: { severity: "HIGH" },
  OUT_OF_SCOPE_CONTENT: { severity: "HIGH" },
  UNREFERENCED_SOURCE: { severity: "LOW" },
  SOURCE_NUMBER_MISMATCH: { severity: "BLOCKER" },
  OPEN_RESEARCH_GAP: { severity: "BLOCKER" },
  EMPTY_REQUIRED_SECTION: { severity: "BLOCKER" }
} as const satisfies Record<string, { severity: QaSeverity }>;

export type QaRuleCode = keyof typeof QA_RULE_DEFINITIONS;
export type QaMetadataValue = string | number | boolean | null;

export interface QaFinding {
  id: string;
  ruleCode: QaRuleCode;
  severity: QaSeverity;
  location: string;
  problem: string;
  remediation: string;
  resolutionStatus: QaResolutionStatus;
  metadata: Record<string, QaMetadataValue>;
}

export interface QaSource {
  id: string;
  title: string;
  publisher?: string | null;
  publishedAt?: DateInput | null;
  contentHash?: string | null;
  duplicateOfSourceId?: string | null;
}

export interface QaEvidence {
  id: string;
  sourceId: string;
  verificationStatus: EvidenceVerificationStatus;
}

export interface QaClaimEvidenceLink {
  claimId: string;
  evidenceId: string;
  relationship: EvidenceRelationship;
  supportExtent?: EvidenceSupportExtent;
}

export type QaClaimImportance = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface QaClaim {
  id: string;
  content: string;
  importance: QaClaimImportance;
  includeInReport: boolean;
  verificationPossible?: boolean;
}

export interface QaSourceConflict {
  id: string;
  claimId?: string | null;
  location: string;
  description: string;
  resolved: boolean;
}

export type QaStatementClassification = "FACT" | "INFERENCE" | "MIXED";

export interface QaReportStatement {
  id: string;
  location: string;
  text: string;
  classification: QaStatementClassification;
  withinScope: boolean;
}

export interface QaQuantitativeAssertion {
  id: string;
  location: string;
  text: string;
  evidenceId?: string | null;
  dateMatchesSource?: boolean | null;
  unitMatchesSource?: boolean | null;
  valueMatchesSource?: boolean | null;
}

export interface QaReportSection {
  id: string;
  title: string;
  required: boolean;
  content: string;
}

export interface QaResearchGap extends ResearchGapState {
  id: string;
  location: string;
  description: string;
}

export interface QaReport {
  citationIds: readonly unknown[];
  sections: readonly QaReportSection[];
  statements: readonly QaReportStatement[];
  quantitativeAssertions: readonly QaQuantitativeAssertion[];
}

export interface QaContext {
  researchDate: DateInput;
  sourceMaxAgeDays: number;
  sources: readonly QaSource[];
  evidence: readonly QaEvidence[];
  claims: readonly QaClaim[];
  claimEvidence: readonly QaClaimEvidenceLink[];
  conflicts: readonly QaSourceConflict[];
  researchGaps: readonly QaResearchGap[];
  report: QaReport;
}

const KEY_CLAIM_IMPORTANCE = new Set<QaClaimImportance>(["CRITICAL", "HIGH"]);
const SOURCE_CONCENTRATION_MINIMUM = 3;
const SOURCE_CONCENTRATION_THRESHOLD = 0.5;

function qaFinding(
  ruleCode: QaRuleCode,
  key: string,
  location: string,
  problem: string,
  remediation: string,
  metadata: Record<string, QaMetadataValue> = {}
): QaFinding {
  return {
    id: `${ruleCode}:${key}`,
    ruleCode,
    severity: QA_RULE_DEFINITIONS[ruleCode].severity,
    location,
    problem,
    remediation,
    resolutionStatus: "OPEN",
    metadata
  };
}

function sourceFreshness(
  source: QaSource,
  context: Pick<QaContext, "researchDate" | "sourceMaxAgeDays">
): SourceFreshnessStatus {
  return assessSourceFreshness({
    publishedAt: source.publishedAt,
    researchDate: context.researchDate,
    maxAgeDays: context.sourceMaxAgeDays
  });
}

export function runQaRules(context: QaContext): QaFinding[] {
  const findings: QaFinding[] = [];
  const sourceById = new Map(context.sources.map((source) => [source.id, source]));
  const evidenceById = new Map(
    context.evidence.map((evidence) => [evidence.id, evidence])
  );
  const claimEvidenceByClaimId = new Map<string, QaClaimEvidenceLink[]>();

  for (const link of context.claimEvidence) {
    const links = claimEvidenceByClaimId.get(link.claimId) ?? [];
    links.push(link);
    claimEvidenceByClaimId.set(link.claimId, links);
  }

  const claimSupportById = new Map<string, ReturnType<typeof calculateClaimSupportStatus>>();
  for (const claim of context.claims) {
    const assessments = (claimEvidenceByClaimId.get(claim.id) ?? []).flatMap(
      (link) => {
        const evidence = evidenceById.get(link.evidenceId);
        const source = evidence ? sourceById.get(evidence.sourceId) : undefined;
        if (!evidence || !source) {
          return [];
        }
        return [
          {
            relationship: link.relationship,
            verificationStatus: evidence.verificationStatus,
            sourceFreshness: sourceFreshness(source, context),
            supportExtent: link.supportExtent
          }
        ];
      }
    );
    const supportStatus = calculateClaimSupportStatus({
      evidence: assessments,
      verificationPossible: claim.verificationPossible
    });
    claimSupportById.set(claim.id, supportStatus);

    const hasVerifiedSupport = assessments.some(
      (assessment) =>
        assessment.relationship === "SUPPORTS" &&
        assessment.verificationStatus === "VERIFIED"
    );
    if (
      claim.includeInReport &&
      KEY_CLAIM_IMPORTANCE.has(claim.importance) &&
      !hasVerifiedSupport
    ) {
      findings.push(
        qaFinding(
          "UNSOURCED_KEY_CLAIM",
          claim.id,
          `claim:${claim.id}`,
          "A key report claim has no verified supporting evidence.",
          "Link and verify supporting evidence, or remove the claim from the report.",
          { claimId: claim.id, supportStatus }
        )
      );
    }
  }

  const citationIssues = findCitationIdIssues(
    context.report.citationIds,
    sourceById.keys()
  );
  for (const issue of citationIssues) {
    findings.push(
      qaFinding(
        "INVALID_CITATION_ID",
        `${issue.index}-${issue.code}`,
        `report:citations[${issue.index}]`,
        `A report citation ID is ${issue.code.toLowerCase()}.`,
        "Use one unique, well-formed citation ID that matches an existing source.",
        {
          citationId: issue.citationId,
          issueType: issue.code,
          citationIndex: issue.index
        }
      )
    );
  }

  const citedSourceIds = new Set(
    context.report.citationIds.filter(
      (citationId): citationId is string =>
        isCitationId(citationId) && sourceById.has(citationId)
    )
  );

  for (const sourceId of citedSourceIds) {
    const source = sourceById.get(sourceId)!;
    if (sourceFreshness(source, context) === "OUTDATED") {
      findings.push(
        qaFinding(
          "OUTDATED_SOURCE",
          source.id,
          `source:${source.id}`,
          "A source cited by the report is older than the project's maximum age.",
          "Replace it with a current source or document why the older source remains necessary.",
          { sourceId: source.id }
        )
      );
    }
  }

  const duplicateSourceIds = new Set<string>();
  for (const source of context.sources) {
    if (source.duplicateOfSourceId) {
      duplicateSourceIds.add(source.id);
      findings.push(
        qaFinding(
          "DUPLICATE_SOURCE",
          source.id,
          `source:${source.id}`,
          "A source is marked as a duplicate of another project source.",
          "Keep one canonical source record and relink its evidence before removing the duplicate.",
          { sourceId: source.id, duplicateOfSourceId: source.duplicateOfSourceId }
        )
      );
    }
  }

  const firstSourceByHash = new Map<string, QaSource>();
  for (const source of context.sources) {
    const contentHash = source.contentHash?.trim();
    if (!contentHash) {
      continue;
    }
    const canonical = firstSourceByHash.get(contentHash);
    if (!canonical) {
      firstSourceByHash.set(contentHash, source);
    } else if (!duplicateSourceIds.has(source.id)) {
      duplicateSourceIds.add(source.id);
      findings.push(
        qaFinding(
          "DUPLICATE_SOURCE",
          source.id,
          `source:${source.id}`,
          "Two source records have the same content hash.",
          "Keep one canonical source record and relink its evidence before removing the duplicate.",
          { sourceId: source.id, duplicateOfSourceId: canonical.id }
        )
      );
    }
  }

  const citedSourcesWithPublisher = [...citedSourceIds]
    .map((sourceId) => sourceById.get(sourceId)!)
    .filter((source) => Boolean(source.publisher?.trim()));
  if (citedSourcesWithPublisher.length >= SOURCE_CONCENTRATION_MINIMUM) {
    const counts = new Map<string, number>();
    for (const source of citedSourcesWithPublisher) {
      const publisher = source.publisher!.trim();
      counts.set(publisher, (counts.get(publisher) ?? 0) + 1);
    }
    for (const [publisher, count] of counts) {
      const share = count / citedSourcesWithPublisher.length;
      if (share > SOURCE_CONCENTRATION_THRESHOLD) {
        findings.push(
          qaFinding(
            "SOURCE_CONCENTRATION",
            publisher,
            "report:sources",
            "The report relies on one publishing organization for a majority of cited sources.",
            "Add independent sources or explain why this concentration is unavoidable.",
            { publisher, sourceCount: count, sourceShare: share }
          )
        );
      }
    }
  }

  const conflictsByClaimId = new Map<string, QaSourceConflict[]>();
  for (const conflict of context.conflicts) {
    if (conflict.claimId) {
      const claimConflicts = conflictsByClaimId.get(conflict.claimId) ?? [];
      claimConflicts.push(conflict);
      conflictsByClaimId.set(conflict.claimId, claimConflicts);
    }
    if (!conflict.resolved) {
      findings.push(
        qaFinding(
          "UNRESOLVED_SOURCE_CONFLICT",
          conflict.id,
          conflict.location,
          "Conflicting source evidence has not been resolved or explained.",
          "Resolve the conflict or document its effect on the finding and report conclusion.",
          { conflictId: conflict.id, claimId: conflict.claimId ?? null }
        )
      );
    }
  }

  for (const claim of context.claims) {
    if (claimSupportById.get(claim.id) !== "CONTESTED") {
      continue;
    }
    const recordedConflicts = conflictsByClaimId.get(claim.id) ?? [];
    if (recordedConflicts.length === 0) {
      findings.push(
        qaFinding(
          "UNRESOLVED_SOURCE_CONFLICT",
          `claim-${claim.id}`,
          `claim:${claim.id}`,
          "Verified evidence both supports and refutes this claim, but no conflict resolution is recorded.",
          "Record the conflict and resolve it or explain its effect on the report conclusion.",
          { claimId: claim.id }
        )
      );
    }
  }

  for (const statement of context.report.statements) {
    if (statement.classification === "MIXED") {
      findings.push(
        qaFinding(
          "FACT_INFERENCE_MIX",
          statement.id,
          statement.location,
          "A report statement mixes fact and inference without distinguishing them.",
          "Split the factual statement from the inference and label each explicitly.",
          { statementId: statement.id }
        )
      );
    }
    if (!statement.withinScope) {
      findings.push(
        qaFinding(
          "OUT_OF_SCOPE_CONTENT",
          statement.id,
          statement.location,
          "Report content falls outside the approved research scope.",
          "Remove the content or obtain explicit approval to expand the scope.",
          { statementId: statement.id }
        )
      );
    }
  }

  for (const assertion of context.report.quantitativeAssertions) {
    const evidence = assertion.evidenceId
      ? evidenceById.get(assertion.evidenceId)
      : undefined;
    if (!evidence || evidence.verificationStatus !== "VERIFIED") {
      findings.push(
        qaFinding(
          "UNSUPPORTED_NUMBER",
          assertion.id,
          assertion.location,
          "A numeric statement has no verified supporting evidence.",
          "Link the number to verified evidence or remove it from the report.",
          { assertionId: assertion.id, evidenceId: assertion.evidenceId ?? null }
        )
      );
    }

    const mismatches = [
      assertion.dateMatchesSource === false ? "date" : null,
      assertion.unitMatchesSource === false ? "unit" : null
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      findings.push(
        qaFinding(
          "DATE_OR_UNIT_MISMATCH",
          assertion.id,
          assertion.location,
          "A numeric statement uses a date or unit that does not match its source.",
          "Correct the date and unit to match the cited evidence.",
          { assertionId: assertion.id, mismatches: mismatches.join(",") }
        )
      );
    }

    if (assertion.valueMatchesSource === false) {
      findings.push(
        qaFinding(
          "SOURCE_NUMBER_MISMATCH",
          assertion.id,
          assertion.location,
          "A number in the report does not match the value in its source evidence.",
          "Correct the reported value and recheck any calculation based on it.",
          { assertionId: assertion.id, evidenceId: assertion.evidenceId ?? null }
        )
      );
    }
  }

  for (const source of context.sources) {
    if (!citedSourceIds.has(source.id)) {
      findings.push(
        qaFinding(
          "UNREFERENCED_SOURCE",
          source.id,
          `source:${source.id}`,
          "A project source is not referenced by the report.",
          "Cite the source where it is used or remove it from the delivery source list.",
          { sourceId: source.id }
        )
      );
    }
  }

  const openGapCount = countOpenResearchGaps(context.researchGaps);
  for (const gap of context.researchGaps) {
    if (gap.gapStatus === "OPEN") {
      findings.push(
        qaFinding(
          "OPEN_RESEARCH_GAP",
          gap.id,
          gap.location,
          "A research gap remains unresolved.",
          "Resolve the gap or explicitly accept and disclose the limitation before approval.",
          { gapId: gap.id, openGapCount }
        )
      );
    }
  }

  for (const section of context.report.sections) {
    if (section.required && section.content.trim().length === 0) {
      findings.push(
        qaFinding(
          "EMPTY_REQUIRED_SECTION",
          section.id,
          `report:section:${section.id}`,
          "A required report section is empty.",
          "Complete the section before requesting approval.",
          { sectionId: section.id, sectionTitle: section.title }
        )
      );
    }
  }

  return findings;
}

export function isBlockingQaFinding(finding: QaFinding): boolean {
  return finding.severity === "BLOCKER" && finding.resolutionStatus !== "RESOLVED";
}

export function hasBlockingQaFindings(findings: readonly QaFinding[]): boolean {
  return findings.some(isBlockingQaFinding);
}

export function isQaApprovalAllowed(findings: readonly QaFinding[]): boolean {
  return !hasBlockingQaFindings(findings);
}

export class QaApprovalBlockedError extends Error {
  readonly blockers: readonly QaFinding[];

  constructor(blockers: readonly QaFinding[]) {
    super("QA approval is blocked by unresolved blocker findings");
    this.name = "QaApprovalBlockedError";
    this.blockers = blockers;
  }
}

export function assertQaApprovalAllowed(findings: readonly QaFinding[]): void {
  const blockers = findings.filter(isBlockingQaFinding);
  if (blockers.length > 0) {
    throw new QaApprovalBlockedError(blockers);
  }
}
