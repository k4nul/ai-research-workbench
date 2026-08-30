import { z } from "zod";

export const AI_STAGES = [
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

export type AIStage = (typeof AI_STAGES)[number];

const nonBlank = z.string().trim().min(1);
const sourceIds = z.array(nonBlank);

export const aiStageOutputSchemas = {
  intake_analysis: z
    .object({
      refinedQuestion: nonBlank,
      ambiguousTerms: z.array(nonBlank),
      exclusions: z.array(nonBlank),
      freshnessRequirement: nonBlank,
      completionCriteria: z.array(nonBlank),
      risks: z.array(nonBlank)
    })
    .strict(),
  question_decomposition: z
    .object({
      questions: z.array(
        z
          .object({
            id: nonBlank,
            question: nonBlank,
            priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
            completionCriteria: z.array(nonBlank)
          })
          .strict()
      )
    })
    .strict(),
  research_plan: z
    .object({
      steps: z.array(
        z
          .object({
            id: nonBlank,
            questionId: nonBlank,
            queries: z.array(nonBlank),
            primarySourceTypes: z.array(nonBlank),
            secondarySourceTypes: z.array(nonBlank),
            completionCondition: nonBlank,
            risks: z.array(nonBlank)
          })
          .strict()
      )
    })
    .strict(),
  source_summary: z
    .object({
      sourceId: nonBlank,
      summary: nonBlank,
      keyPoints: z.array(nonBlank),
      limitations: z.array(nonBlank),
      promptInjectionSuspected: z.boolean()
    })
    .strict(),
  evidence_extraction: z
    .object({
      evidence: z.array(
        z
          .object({
            sourceId: nonBlank,
            summary: nonBlank,
            minimalQuote: z.string(),
            location: nonBlank,
            stance: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]),
            confidence: z.enum(["HIGH", "MEDIUM", "LOW"])
          })
          .strict()
      )
    })
    .strict(),
  claim_generation: z
    .object({
      claims: z.array(
        z
          .object({
            id: nonBlank,
            text: nonBlank,
            type: z.enum(["FACT", "INTERPRETATION", "INFERENCE", "RECOMMENDATION"]),
            importance: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
            sourceIds
          })
          .strict()
      )
    })
    .strict(),
  gap_detection: z
    .object({
      gaps: z.array(
        z
          .object({
            questionId: nonBlank,
            description: nonBlank,
            severity: z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW"]),
            nextSearches: z.array(nonBlank)
          })
          .strict()
      )
    })
    .strict(),
  conflict_detection: z
    .object({
      conflicts: z.array(
        z
          .object({
            description: nonBlank,
            sourceIds,
            materiality: z.enum(["HIGH", "MEDIUM", "LOW"]),
            resolutionNeeded: z.boolean()
          })
          .strict()
      )
    })
    .strict(),
  report_outline: z
    .object({
      sections: z.array(
        z
          .object({
            title: nonBlank,
            purpose: nonBlank,
            claimIds: z.array(nonBlank),
            sourceIds
          })
          .strict()
      )
    })
    .strict(),
  draft_generation: z
    .object({
      title: nonBlank,
      markdown: nonBlank,
      citationSourceIds: sourceIds,
      limitations: z.array(nonBlank)
    })
    .strict(),
  qa_revision: z
    .object({
      issues: z.array(
        z
          .object({
            severity: z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW"]),
            location: nonBlank,
            problem: nonBlank,
            suggestion: nonBlank,
            sourceIds
          })
          .strict()
      ),
      revisedText: z.string()
    })
    .strict()
} satisfies Record<AIStage, z.ZodType>;

export type AIStageOutputMap = {
  [Stage in AIStage]: z.infer<(typeof aiStageOutputSchemas)[Stage]>;
};

export interface AIStageInputMap {
  intake_analysis: {
    brief: string;
    audience?: string;
    jurisdiction?: string;
    asOfDate?: string;
  };
  question_decomposition: {
    coreQuestion: string;
    scope: string;
    completionCriteria: readonly string[];
  };
  research_plan: {
    questions: readonly { id: string; question: string }[];
    constraints: readonly string[];
  };
  source_summary: {
    sourceId: string;
    content: string;
    sourceMetadata?: Readonly<Record<string, unknown>>;
  };
  evidence_extraction: {
    sources: readonly { sourceId: string; content: string }[];
    claimHint?: string;
  };
  claim_generation: {
    evidence: readonly { sourceId: string; summary: string }[];
    researchQuestion: string;
  };
  gap_detection: {
    questions: readonly { id: string; question: string }[];
    claims: readonly {
      questionId?: string;
      text: string;
      sourceIds: readonly string[];
    }[];
  };
  conflict_detection: {
    claims: readonly { text: string; sourceIds: readonly string[] }[];
    evidence: readonly { sourceId: string; summary: string }[];
  };
  report_outline: {
    findings: readonly {
      id: string;
      summary: string;
      sourceIds: readonly string[];
    }[];
    claimIds: readonly string[];
  };
  draft_generation: {
    title: string;
    outline: readonly { title: string; purpose: string }[];
    claims: readonly { id: string; text: string; sourceIds: readonly string[] }[];
  };
  qa_revision: {
    draft: string;
    qaFindings: readonly { severity: string; location: string; problem: string }[];
  };
}

export interface AIStageRequest<Stage extends AIStage> {
  stage: Stage;
  projectId: string;
  promptTemplateVersion: string;
  input: AIStageInputMap[Stage];
  allowedSourceIds: readonly string[];
}

export type AnyAIStageRequest = {
  [Stage in AIStage]: AIStageRequest<Stage>;
}[AIStage];

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIExecutionMetadata {
  provider: string;
  model: string;
  stage: AIStage;
  promptTemplateVersion: string;
  projectId: string;
  inputHash: string;
  startedAt: string;
  durationMs: number;
  requestId?: string;
  usage?: AIUsage;
}

export type AIExecutionResult<Stage extends AIStage> =
  | {
      success: true;
      output: AIStageOutputMap[Stage];
      metadata: AIExecutionMetadata;
    }
  | {
      success: false;
      error: {
        code:
          | "NOT_CONFIGURED"
          | "PROVIDER_ERROR"
          | "INVALID_RESPONSE"
          | "UNKNOWN_SOURCE_ID"
          | "TIMEOUT";
        message: string;
      };
      metadata: AIExecutionMetadata;
    };

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  isConfigured(): boolean;
  run<Stage extends AIStage>(
    request: AIStageRequest<Stage>
  ): Promise<AIExecutionResult<Stage>>;
}

export interface SearchQuery {
  query: string;
  count?: number;
  country?: string;
  searchLanguage?: string;
  uiLanguage?: string;
  safeSearch?: "off" | "moderate" | "strict";
  freshness?: "pd" | "pw" | "pm" | "py" | `${string}to${string}`;
}

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  language?: string;
}

export interface SearchResponse {
  provider: string;
  query: string;
  results: readonly SearchHit[];
  metadata: {
    startedAt: string;
    durationMs: number;
    requestId?: string;
  };
}

export interface SearchProvider {
  readonly id: string;
  isConfigured(): boolean;
  search(query: SearchQuery): Promise<SearchResponse>;
}

export interface ProviderStatus {
  kind: "ai" | "search";
  provider: string;
  active: boolean;
  configured: boolean;
  mode: "mock" | "live";
  model?: string;
  credential: string;
}
