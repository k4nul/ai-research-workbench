import { describe, expect, it } from "vitest";
import {
  evaluateCorpus,
  SYNTHETIC_EVAL_GOLD,
  SYNTHETIC_EVAL_INPUTS,
  type EvalFixtureExecution,
  type EvalGoldLabels,
  type EvalRunObservation
} from "@/lib/evaluation";

const stages = [
  "intake_analysis",
  "question_decomposition",
  "research_plan",
  "source_summary",
  "evidence_extraction",
  "claim_generation",
  "gap_detection",
  "conflict_detection",
  "report_outline",
  "draft_generation",
  "qa_revision"
] as const;

const gold: EvalGoldLabels = {
  fixtureId: "supported",
  reportableSourceKeys: ["source-a"],
  staleSourceKeys: [],
  conflicts: [],
  gapQuestionKeys: [],
  qaBlockerKeys: [],
  promptInjectionSourceKeys: [],
  requiredReportSections: [
    "executiveSummary",
    "keyFindings",
    "risksAndLimitations",
    "references"
  ],
  expectedRunStatus: "APPROVAL_REQUIRED"
};

function observation(scope: "primary" | "repeat"): EvalRunObservation {
  const projectId = `project-${scope}`;
  const sourceId = `source-${scope}`;
  const evidenceId = `evidence-${scope}`;
  return {
    fixtureId: "supported",
    projectId,
    runId: `run-${scope}`,
    runStatus: "APPROVAL_REQUIRED",
    provider: "mock-ai",
    model: "deterministic-fixture-v1",
    pipelineVersion: "research-pipeline-v2",
    promptVersion: "research-prompts-v2",
    succeededStageIds: stages,
    normalizedStageOutputs: Object.fromEntries(
      stages.map((stage) => [stage, { stage, result: "stable" }])
    ),
    sources: [
      {
        id: sourceId,
        key: "source-a",
        projectId,
        freshnessStatus: "CURRENT",
        promptInjectionFlag: false,
        duplicateOfSourceKey: null
      }
    ],
    evidence: [
      {
        id: evidenceId,
        sourceId,
        sourceKey: "source-a",
        sourceProjectId: projectId,
        summary: "Synthetic support.",
        verificationStatus: "PENDING"
      }
    ],
    claims: [
      {
        id: `claim-${scope}`,
        questionKey: "question-a",
        content: "Synthetic supported claim.",
        importance: "HIGH",
        withinScope: true,
        evidenceLinks: [
          {
            evidenceId,
            evidenceExists: true,
            relationship: "SUPPORTS",
            sourceId,
            sourceKey: "source-a",
            sourceProjectId: projectId
          }
        ]
      }
    ],
    findings: [],
    gaps: [],
    conflicts: [],
    qaFindings: [],
    reportSections: {
      executiveSummary: "Synthetic summary.",
      keyFindings: "Synthetic finding.",
      risksAndLimitations: "Synthetic limitation.",
      references: "[@source:source-a]"
    },
    citations: [
      {
        sourceId,
        sourceKey: "source-a",
        sourceProjectId: projectId
      }
    ],
    providerRequestCount: 11,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0
  };
}

function execution(): EvalFixtureExecution {
  return {
    fixtureId: "supported",
    primary: observation("primary"),
    repeat: observation("repeat")
  };
}

function score(
  mutate: (value: EvalFixtureExecution, labels: EvalGoldLabels) => void
) {
  const value = structuredClone(execution());
  const labels = structuredClone(gold);
  mutate(value, labels);
  return evaluateCorpus([value], [labels], {
    now: () => new Date("2026-08-30T00:00:00.000Z")
  });
}

describe("strict synthetic research evaluation policy", () => {
  it("keeps the ten named inputs separate from independently reviewed gold labels", () => {
    expect(SYNTHETIC_EVAL_INPUTS).toHaveLength(10);
    expect(SYNTHETIC_EVAL_GOLD).toHaveLength(10);
    expect(SYNTHETIC_EVAL_INPUTS.map((fixture) => fixture.id)).toEqual(
      SYNTHETIC_EVAL_GOLD.map((labels) => labels.fixtureId)
    );
    expect(
      SYNTHETIC_EVAL_INPUTS.every(
        (fixture) =>
          fixture.synthetic &&
          !("gold" in fixture) &&
          !("detections" in fixture) &&
          !("deterministicOutput" in fixture)
      )
    ).toBe(true);
  });

  it("fails a nonexistent report citation", () => {
    const result = score((value) => {
      for (const run of [value.primary, value.repeat]) {
        run.citations = [
          {
            sourceId: "invented-source",
            sourceKey: null,
            sourceProjectId: null
          }
        ];
      }
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.citationIntegrity).toBe(0);
    expect(result.failures).toContain("citationIntegrity 0.0000 is below 1");
  });

  it("fails an unsupported critical claim", () => {
    const result = score((value) => {
      for (const run of [value.primary, value.repeat]) {
        run.claims = [
          ...run.claims,
          {
            id: `critical-${run.runId}`,
            questionKey: "question-a",
            content: "Unsupported critical claim.",
            importance: "CRITICAL",
            withinScope: true,
            evidenceLinks: []
          }
        ];
      }
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.unsupportedCriticalClaimCount).toBe(1);
    expect(result.failures).toContain(
      "unsupportedCriticalClaimCount 1 exceeds 0"
    );
  });

  it("fails when an unresolved QA blocker reaches the approval boundary", () => {
    const result = score((value, labels) => {
      labels.qaBlockerKeys = ["required-blocker"];
      for (const run of [value.primary, value.repeat]) {
        run.qaFindings = [
          {
            ruleCode: "EVAL_REQUIRED_BLOCKER",
            severity: "BLOCKER",
            location: "report:fixture",
            problem: "Synthetic unresolved blocker.",
            resolutionStatus: "OPEN",
            evalKey: "required-blocker",
            sourceKeys: []
          }
        ];
      }
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.qaBlockerRecall).toBe(1);
    expect(result.metrics.qaBlockerBypassCount).toBe(1);
    expect(result.failures).toContain("qaBlockerBypassCount 1 exceeds 0");
  });

  it("fails a cross-project citation", () => {
    const result = score((value) => {
      for (const run of [value.primary, value.repeat]) {
        run.citations = [
          {
            sourceId: `outside-${run.runId}`,
            sourceKey: "outside-source",
            sourceProjectId: `outside-project-${run.runId}`
          }
        ];
      }
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.crossProjectEvidenceReferenceCount).toBe(1);
    expect(result.failures).toContain(
      "crossProjectEvidenceReferenceCount 1 exceeds 0"
    );
  });

  it("fails a prompt-injection policy bypass", () => {
    const result = score((_value, labels) => {
      labels.promptInjectionSourceKeys = ["source-a"];
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.promptInjectionPolicyBypassCount).toBe(1);
    expect(result.failures).toContain(
      "promptInjectionPolicyBypassCount 1 exceeds 0"
    );
  });

  it("fails a nondeterministic repeated pipeline output", () => {
    const result = score((value) => {
      value.repeat.normalizedStageOutputs = {
        ...value.repeat.normalizedStageOutputs,
        draft_generation: { changed: true }
      };
    });

    expect(result.passed).toBe(false);
    expect(result.metrics.deterministicHashMismatchCount).toBe(1);
    expect(result.failures).toContain(
      "deterministicHashMismatchCount 1 exceeds 0"
    );
  });
});
