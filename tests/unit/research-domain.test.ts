import { describe, expect, it } from "vitest";
import {
  CitationIdValidationError,
  assessSourceFreshness,
  calculateClaimSupportStatus,
  calculateWorkflowProgress,
  countOpenResearchGaps,
  findCitationIdIssues,
  validateCitationIds,
  type WorkflowGateState
} from "@/lib/domain/research";

const incompleteWorkflow: WorkflowGateState = {
  scopeConfirmed: false,
  planApproved: false,
  questionsResearched: false,
  claimsLinkedToEvidence: false,
  reportWritten: false,
  qaPassed: false,
  humanApproved: false,
  deliverablesGenerated: false
};

describe("calculateWorkflowProgress", () => {
  it("derives progress from the eight workflow gates", () => {
    expect(calculateWorkflowProgress(incompleteWorkflow)).toBe(0);
    expect(
      calculateWorkflowProgress({
        ...incompleteWorkflow,
        scopeConfirmed: true,
        planApproved: true,
        questionsResearched: true,
        claimsLinkedToEvidence: true
      })
    ).toBe(50);
    expect(
      calculateWorkflowProgress(
        Object.fromEntries(
          Object.keys(incompleteWorkflow).map((gate) => [gate, true])
        ) as WorkflowGateState
      )
    ).toBe(100);
  });

  it("rounds fractional gate percentages to the integer persistence contract", () => {
    expect(
      calculateWorkflowProgress({ ...incompleteWorkflow, scopeConfirmed: true })
    ).toBe(13);
    expect(
      calculateWorkflowProgress({
        ...incompleteWorkflow,
        scopeConfirmed: true,
        planApproved: true,
        questionsResearched: true,
        claimsLinkedToEvidence: true,
        reportWritten: true,
        qaPassed: true,
        humanApproved: true
      })
    ).toBe(88);
  });
});

describe("assessSourceFreshness", () => {
  it("uses the research date rather than the current clock", () => {
    expect(
      assessSourceFreshness({
        publishedAt: "2026-03-01",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("CURRENT");
    expect(
      assessSourceFreshness({
        publishedAt: "2026-01-21",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("AGING");
    expect(
      assessSourceFreshness({
        publishedAt: "2025-12-31",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("OUTDATED");
  });

  it("keeps the exact maximum age eligible and marks missing or future dates unknown", () => {
    expect(
      assessSourceFreshness({
        publishedAt: "2026-01-01",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("AGING");
    expect(
      assessSourceFreshness({
        publishedAt: null,
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("UNKNOWN");
    expect(
      assessSourceFreshness({
        publishedAt: "2026-04-12",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toBe("UNKNOWN");
  });

  it("rejects invalid dates and maximum ages", () => {
    expect(() =>
      assessSourceFreshness({
        publishedAt: "2026-02-30",
        researchDate: "2026-04-11",
        maxAgeDays: 100
      })
    ).toThrow("publishedAt must be a valid date");
    expect(() =>
      assessSourceFreshness({
        publishedAt: "2026-01-01",
        researchDate: "2026-04-11",
        maxAgeDays: -1
      })
    ).toThrow("maxAgeDays must be a non-negative integer");
  });
});

describe("calculateClaimSupportStatus", () => {
  const verifiedSupport = {
    relationship: "SUPPORTS" as const,
    verificationStatus: "VERIFIED" as const,
    sourceFreshness: "CURRENT" as const
  };

  it("derives every supported-state outcome from verified evidence", () => {
    expect(calculateClaimSupportStatus({ evidence: [verifiedSupport] })).toBe(
      "SUPPORTED"
    );
    expect(
      calculateClaimSupportStatus({
        evidence: [{ ...verifiedSupport, supportExtent: "PARTIAL" }]
      })
    ).toBe("PARTIALLY_SUPPORTED");
    expect(
      calculateClaimSupportStatus({
        evidence: [{ ...verifiedSupport, sourceFreshness: "OUTDATED" }]
      })
    ).toBe("OUTDATED");
    expect(
      calculateClaimSupportStatus({
        evidence: [
          verifiedSupport,
          { ...verifiedSupport, relationship: "REFUTES" }
        ]
      })
    ).toBe("CONTESTED");
    expect(calculateClaimSupportStatus({ evidence: [] })).toBe("UNSUPPORTED");
    expect(
      calculateClaimSupportStatus({ evidence: [], verificationPossible: false })
    ).toBe("NOT_VERIFIABLE");
  });

  it("ignores pending, rejected, and context-only evidence", () => {
    expect(
      calculateClaimSupportStatus({
        evidence: [
          { ...verifiedSupport, verificationStatus: "PENDING" },
          { ...verifiedSupport, verificationStatus: "REJECTED" },
          { ...verifiedSupport, relationship: "CONTEXT" }
        ]
      })
    ).toBe("UNSUPPORTED");
  });
});

describe("citation ID validation", () => {
  it("returns known, unique, well-formed citation IDs", () => {
    expect(validateCitationIds(["source-1", "source:2"], ["source-1", "source:2"]))
      .toEqual(["source-1", "source:2"]);
  });

  it("reports and rejects unknown, duplicate, and malformed IDs", () => {
    const citationIds = ["source-1", "source-1", "missing", "[source-2]", 42];
    expect(findCitationIdIssues(citationIds, ["source-1", "source-2"])).toEqual([
      { code: "DUPLICATE", index: 1, citationId: "source-1" },
      { code: "UNKNOWN", index: 2, citationId: "missing" },
      { code: "MALFORMED", index: 3, citationId: "[source-2]" },
      { code: "MALFORMED", index: 4, citationId: null }
    ]);

    try {
      validateCitationIds(citationIds, ["source-1", "source-2"]);
      throw new Error("expected citation validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CitationIdValidationError);
      expect((error as CitationIdValidationError).issues).toHaveLength(4);
    }
  });
});

describe("countOpenResearchGaps", () => {
  it("counts only unresolved open gaps", () => {
    expect(
      countOpenResearchGaps([
        { gapStatus: "NONE" },
        { gapStatus: "OPEN" },
        { gapStatus: "OPEN" },
        { gapStatus: "ACCEPTED" },
        { gapStatus: "RESOLVED" }
      ])
    ).toBe(2);
  });
});
