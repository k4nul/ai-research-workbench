import { describe, expect, it } from "vitest";
import {
  QA_RULE_DEFINITIONS,
  QaApprovalBlockedError,
  assertQaApprovalAllowed,
  hasBlockingQaFindings,
  isBlockingQaFinding,
  isQaApprovalAllowed,
  runQaRules,
  type QaContext,
  type QaFinding,
  type QaRuleCode
} from "@/lib/domain/qa";

function cleanContext(): QaContext {
  return {
    researchDate: "2026-08-30",
    sourceMaxAgeDays: 365,
    sources: [
      {
        id: "source-1",
        title: "Primary source",
        publisher: "Publisher A",
        publishedAt: "2026-08-01",
        contentHash: "hash-1"
      },
      {
        id: "source-2",
        title: "Independent source",
        publisher: "Publisher B",
        publishedAt: "2026-07-01",
        contentHash: "hash-2"
      },
      {
        id: "source-3",
        title: "Third source",
        publisher: "Publisher C",
        publishedAt: "2026-06-01",
        contentHash: "hash-3"
      }
    ],
    evidence: [
      {
        id: "evidence-1",
        sourceId: "source-1",
        verificationStatus: "VERIFIED"
      }
    ],
    claims: [
      {
        id: "claim-1",
        content: "The primary finding is supported.",
        importance: "HIGH",
        includeInReport: true
      }
    ],
    claimEvidence: [
      {
        claimId: "claim-1",
        evidenceId: "evidence-1",
        relationship: "SUPPORTS",
        supportExtent: "FULL"
      }
    ],
    conflicts: [],
    researchGaps: [
      {
        id: "gap-1",
        location: "question:1",
        description: "Resolved gap",
        gapStatus: "RESOLVED"
      }
    ],
    report: {
      citationIds: ["source-1", "source-2", "source-3"],
      sections: [
        {
          id: "executive-summary",
          title: "Executive Summary",
          required: true,
          content: "A complete summary."
        }
      ],
      statements: [
        {
          id: "statement-1",
          location: "report:analysis:1",
          text: "A clearly identified fact.",
          classification: "FACT",
          withinScope: true
        }
      ],
      quantitativeAssertions: [
        {
          id: "number-1",
          location: "report:analysis:2",
          text: "The result was 10 percent.",
          evidenceId: "evidence-1",
          dateMatchesSource: true,
          unitMatchesSource: true,
          valueMatchesSource: true
        }
      ]
    }
  };
}

function contextWithEveryRuleViolation(): QaContext {
  return {
    researchDate: "2026-08-30",
    sourceMaxAgeDays: 365,
    sources: [
      {
        id: "source-old",
        title: "Outdated source",
        publisher: "Publisher A",
        publishedAt: "2020-01-01"
      },
      {
        id: "source-duplicate",
        title: "Duplicate source",
        publisher: "Publisher A",
        publishedAt: "2026-08-01",
        duplicateOfSourceId: "source-old"
      },
      {
        id: "source-independent",
        title: "Independent source",
        publisher: "Publisher B",
        publishedAt: "2026-07-01"
      },
      {
        id: "source-unused",
        title: "Unused source",
        publisher: "Publisher C",
        publishedAt: "2026-07-15"
      }
    ],
    evidence: [
      {
        id: "evidence-support",
        sourceId: "source-duplicate",
        verificationStatus: "VERIFIED"
      },
      {
        id: "evidence-refute",
        sourceId: "source-independent",
        verificationStatus: "VERIFIED"
      }
    ],
    claims: [
      {
        id: "claim-unsourced",
        content: "A key claim without evidence.",
        importance: "CRITICAL",
        includeInReport: true
      },
      {
        id: "claim-contested",
        content: "A contested claim.",
        importance: "MEDIUM",
        includeInReport: true
      }
    ],
    claimEvidence: [
      {
        claimId: "claim-contested",
        evidenceId: "evidence-support",
        relationship: "SUPPORTS"
      },
      {
        claimId: "claim-contested",
        evidenceId: "evidence-refute",
        relationship: "REFUTES"
      }
    ],
    conflicts: [
      {
        id: "conflict-1",
        claimId: "claim-contested",
        location: "claim:claim-contested",
        description: "Sources reach incompatible conclusions.",
        resolved: false
      }
    ],
    researchGaps: [
      {
        id: "gap-open",
        location: "question:missing-data",
        description: "A required data point was not found.",
        gapStatus: "OPEN"
      }
    ],
    report: {
      citationIds: [
        "source-old",
        "source-duplicate",
        "source-independent",
        "source-missing"
      ],
      sections: [
        {
          id: "executive-summary",
          title: "Executive Summary",
          required: true,
          content: "   "
        }
      ],
      statements: [
        {
          id: "statement-mixed",
          location: "report:analysis:1",
          text: "A fact and inference presented as one statement.",
          classification: "MIXED",
          withinScope: false
        }
      ],
      quantitativeAssertions: [
        {
          id: "number-bad",
          location: "report:analysis:2",
          text: "The unsupported result was 90 kilograms in 2025.",
          evidenceId: null,
          dateMatchesSource: false,
          unitMatchesSource: false,
          valueMatchesSource: false
        }
      ]
    }
  };
}

describe("runQaRules", () => {
  it("passes a complete, evidence-backed report context", () => {
    expect(runQaRules(cleanContext())).toEqual([]);
  });

  it("executes all 14 required quality rules", () => {
    const findings = runQaRules(contextWithEveryRuleViolation());
    const triggeredRules = new Set(findings.map((finding) => finding.ruleCode));
    const requiredRules = new Set(
      Object.keys(QA_RULE_DEFINITIONS) as QaRuleCode[]
    );

    expect(triggeredRules).toEqual(requiredRules);
    expect(requiredRules.size).toBe(14);
    expect(findings.every((finding) => finding.resolutionStatus === "OPEN")).toBe(
      true
    );
  });

  it("reports citation validation details and open-gap count as structured metadata", () => {
    const findings = runQaRules(contextWithEveryRuleViolation());
    const citation = findings.find(
      (finding) => finding.ruleCode === "INVALID_CITATION_ID"
    );
    const gap = findings.find(
      (finding) => finding.ruleCode === "OPEN_RESEARCH_GAP"
    );

    expect(citation?.metadata).toMatchObject({
      citationId: "source-missing",
      issueType: "UNKNOWN"
    });
    expect(gap?.metadata.openGapCount).toBe(1);
  });

  it("detects hash duplicates and unrecorded contested evidence", () => {
    const context = cleanContext();
    context.sources = context.sources.map((source) =>
      source.id === "source-2" ? { ...source, contentHash: "hash-1" } : source
    );
    context.claimEvidence = [
      ...context.claimEvidence,
      {
        claimId: "claim-1",
        evidenceId: "evidence-2",
        relationship: "REFUTES"
      }
    ];
    context.evidence = [
      ...context.evidence,
      {
        id: "evidence-2",
        sourceId: "source-2",
        verificationStatus: "VERIFIED"
      }
    ];

    const rules = runQaRules(context).map((finding) => finding.ruleCode);
    expect(rules).toContain("DUPLICATE_SOURCE");
    expect(rules).toContain("UNRESOLVED_SOURCE_CONFLICT");
  });
});

describe("strict QA blocker semantics", () => {
  const blocker: QaFinding = {
    id: "blocker-1",
    ruleCode: "UNSOURCED_KEY_CLAIM",
    severity: "BLOCKER",
    location: "claim:1",
    problem: "Missing evidence",
    remediation: "Add evidence",
    resolutionStatus: "OPEN",
    metadata: {}
  };
  const highFinding: QaFinding = {
    ...blocker,
    id: "high-1",
    ruleCode: "OUTDATED_SOURCE",
    severity: "HIGH"
  };

  it("blocks approval for open and accepted-risk blockers", () => {
    expect(isBlockingQaFinding(blocker)).toBe(true);
    expect(
      isBlockingQaFinding({ ...blocker, resolutionStatus: "ACCEPTED_RISK" })
    ).toBe(true);
    expect(hasBlockingQaFindings([highFinding, blocker])).toBe(true);
    expect(isQaApprovalAllowed([highFinding, blocker])).toBe(false);
    expect(() => assertQaApprovalAllowed([blocker])).toThrow(
      QaApprovalBlockedError
    );
  });

  it("allows approval only after every blocker is resolved", () => {
    const resolvedBlocker = { ...blocker, resolutionStatus: "RESOLVED" as const };
    expect(isBlockingQaFinding(resolvedBlocker)).toBe(false);
    expect(hasBlockingQaFindings([highFinding, resolvedBlocker])).toBe(false);
    expect(isQaApprovalAllowed([highFinding, resolvedBlocker])).toBe(true);
    expect(() => assertQaApprovalAllowed([highFinding, resolvedBlocker])).not.toThrow();
  });
});
