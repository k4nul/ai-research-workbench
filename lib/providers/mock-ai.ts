import { assessPromptInjection } from "@/lib/security";
import {
  inputHash,
  parseStageOutput,
  stableJson,
  unknownSourceIds,
  validateAllowedSourceIds
} from "./ai-shared";
import type {
  AIExecutionMetadata,
  AIExecutionResult,
  AIProvider,
  AIStage,
  AIStageOutputMap,
  AIStageRequest,
  AnyAIStageRequest
} from "./types";

function deterministicId(prefix: string, value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${prefix}-${normalized || "item"}`;
}

function untrustedSourceData(value: string): string {
  const match = value.match(
    /<source_data\s+source_id="[^"]+">\s*([\s\S]*?)\s*<\/source_data>/
  );
  return (match?.[1] ?? value).replace(/\s+/g, " ").trim();
}

function isUsableEvidence(value: string): boolean {
  return !/\b(?:no usable evidence|not relevant to (?:the )?research question)\b/i.test(
    value
  );
}

function evidenceFingerprint(value: string): string {
  return untrustedSourceData(value).toLowerCase();
}

function estimatedTokens(value: unknown): number {
  return Math.max(1, Math.ceil(stableJson(value).length / 4));
}

function buildOutput(request: AnyAIStageRequest): AIStageOutputMap[AIStage] {
  switch (request.stage) {
    case "intake_analysis":
      return {
        refinedQuestion: request.input.brief.trim(),
        ambiguousTerms: [],
        exclusions: [],
        freshnessRequirement: request.input.asOfDate
          ? `Use sources current as of ${request.input.asOfDate}.`
          : "Record publication and access dates for every time-sensitive source.",
        expectedSources: ["Official publications", "Primary data", "Independent analysis"],
        completionCriteria: ["Every material claim is linked to evidence."],
        risks: ["Synthetic demo output requires human review."]
      };
    case "question_decomposition":
      return {
        questions: [
          {
            id: deterministicId("question", request.input.coreQuestion),
            question: request.input.coreQuestion.trim(),
            priority: "HIGH",
            completionCriteria:
              request.input.completionCriteria.length > 0
                ? [...request.input.completionCriteria]
                : ["Answer with cited evidence or record a research gap."]
          }
        ]
      };
    case "research_plan":
      return {
        steps: request.input.questions.map((question) => ({
          id: `plan-${question.id}`,
          questionId: question.id,
          searchStrategy: "Start with authoritative primary sources, then triangulate material claims.",
          queries: [question.question],
          primarySourceTypes: ["official publication"],
          secondarySourceTypes: ["reputable analysis"],
          comparisonTargets: ["supporting evidence", "contradicting evidence"],
          expectedOutput: `A cited answer to: ${question.question}`,
          completionCondition: "At least one primary source is assessed.",
          risks: ["Source freshness must be verified."],
          researchGap: null
        }))
      };
    case "source_summary": {
      const sourceData = untrustedSourceData(request.input.content);
      return {
        sourceId: request.input.sourceId,
        summary: sourceData.slice(0, 320) || "Empty source.",
        keyPoints: ["Review the source content and provenance before use."],
        limitations: ["This is deterministic demo summarization."],
        promptInjectionSuspected: assessPromptInjection(sourceData).flagged
      };
    }
    case "evidence_extraction": {
      const seen = new Set<string>();
      return {
        evidence: request.input.sources.flatMap((source) => {
          const sourceData = untrustedSourceData(source.content);
          const fingerprint = evidenceFingerprint(source.content);
          if (!isUsableEvidence(sourceData) || seen.has(fingerprint)) {
            return [];
          }
          seen.add(fingerprint);
          return [
            {
              sourceId: source.sourceId,
              summary: sourceData.slice(0, 180) || "No evidence text.",
              minimalQuote: sourceData.slice(0, 120),
              location: "fixture:content",
              stance: "CONTEXT" as const,
              confidence: "MEDIUM" as const
            }
          ];
        })
      };
    }
    case "claim_generation":
      return {
        claims:
          request.input.evidence.length === 0
            ? []
            : [
                {
                  id: deterministicId("claim", request.input.researchQuestion),
                  text: `Demo claim for: ${request.input.researchQuestion.trim()}`,
                  type: "FACT",
                  importance: "HIGH",
                  sourceIds: request.input.evidence
                    .map((item) => item.sourceId)
                    .filter((sourceId) => request.allowedSourceIds.includes(sourceId))
                }
              ]
      };
    case "gap_detection":
      return {
        gaps: request.input.questions
          .filter(
            (question) =>
              !request.input.claims.some(
                (claim) =>
                  claim.questionId === question.id && claim.sourceIds.length > 0
              )
          )
          .map((question) => ({
            questionId: question.id,
            description: `No supported claim currently answers: ${question.question}`,
            severity: "HIGH",
            nextSearches: [question.question]
          }))
      };
    case "conflict_detection":
      return {
        conflicts: request.input.claims
          .filter((claim) => {
            const related = request.input.evidence.filter((evidence) =>
              claim.sourceIds.includes(evidence.sourceId)
            );
            const positive = related.some((evidence) =>
              /\b(increase|supports?|yes|available|effective)\b/i.test(evidence.summary)
            );
            const negative = related.some((evidence) =>
              /\b(decrease|contradicts?|no|not available|ineffective)\b/i.test(
                evidence.summary
              )
            );
            return positive && negative;
          })
          .map((claim) => ({
            description: `Sources disagree about: ${claim.text}`,
            sourceIds: [...claim.sourceIds],
            materiality: "HIGH",
            resolutionNeeded: true
          }))
      };
    case "report_outline":
      return {
        sections: [
          {
            title: "Executive Summary",
            purpose: "Summarize evidence-backed findings and limitations.",
            claimIds: [...request.input.claimIds],
            sourceIds: [
              ...new Set(
                request.input.findings
                  .flatMap((finding) => finding.sourceIds)
                  .filter((sourceId) => request.allowedSourceIds.includes(sourceId))
              )
            ]
          }
        ]
      };
    case "draft_generation": {
      const cited = [
        ...new Set(
          request.input.claims
            .flatMap((claim) => claim.sourceIds)
            .filter((sourceId) => request.allowedSourceIds.includes(sourceId))
        )
      ];
      return {
        title: request.input.title.trim(),
        markdown:
          `# ${request.input.title.trim()}\n\nSynthetic demo draft. Human approval is required.` +
          (cited.length > 0
            ? `\n\n${cited.map((sourceId) => `[@${sourceId}]`).join(" ")}`
            : ""),
        citationSourceIds: cited,
        limitations: ["Generated by the deterministic mock provider."]
      };
    }
    case "qa_revision":
      return {
        issues: request.input.qaFindings.map((finding) => ({
          severity: ["BLOCKER", "HIGH", "MEDIUM", "LOW"].includes(finding.severity)
            ? (finding.severity as "BLOCKER" | "HIGH" | "MEDIUM" | "LOW")
            : "MEDIUM",
          location: finding.location,
          problem: finding.problem,
          suggestion: "Resolve this issue with verified evidence before approval.",
          sourceIds: []
        })),
        revisedText: request.input.draft
      };
  }
}

export class MockAIProvider implements AIProvider {
  readonly id = "mock-ai";
  readonly model = "deterministic-fixture-v1";

  constructor(private readonly now: () => Date = () => new Date()) {}

  isConfigured(): boolean {
    return true;
  }

  async run<Stage extends AIStage>(
    request: AIStageRequest<Stage>
  ): Promise<AIExecutionResult<Stage>> {
    const startedAt = this.now();
    const metadata: AIExecutionMetadata = {
      provider: this.id,
      model: this.model,
      stage: request.stage,
      promptTemplateVersion: request.promptTemplateVersion,
      projectId: request.projectId,
      inputHash: inputHash(request.input),
      startedAt: startedAt.toISOString(),
      durationMs: 0
    };
    try {
      validateAllowedSourceIds(request.allowedSourceIds);
      const requestUnknownIds = unknownSourceIds(request.input, request.allowedSourceIds);
      if (requestUnknownIds.length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_SOURCE_ID",
            message: "AI input referenced a source outside the allowlist"
          },
          metadata
        };
      }
      const output = parseStageOutput(
        request.stage,
        buildOutput(request as AnyAIStageRequest)
      );
      const unknownIds = unknownSourceIds(output, request.allowedSourceIds);
      if (unknownIds.length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_SOURCE_ID",
            message: "AI output referenced a source outside the allowlist"
          },
          metadata
        };
      }
      const inputTokens = estimatedTokens(request.input);
      const outputTokens = estimatedTokens(output);
      return {
        success: true,
        output,
        metadata: {
          ...metadata,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens
          }
        }
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "INVALID_RESPONSE",
          message: error instanceof Error ? error.message : "Mock AI output was invalid"
        },
        metadata
      };
    }
  }
}
