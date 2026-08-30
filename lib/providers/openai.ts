import { z } from "zod";
import { EXTERNAL_CONTENT_INSTRUCTION } from "@/lib/security";
import {
  inputHash,
  parseStageOutput,
  stableJson,
  unknownSourceIds,
  validateAllowedSourceIds
} from "./ai-shared";
import {
  aiStageOutputSchemas,
  type AIExecutionMetadata,
  type AIExecutionResult,
  type AIProvider,
  type AIStage,
  type AIStageRequest,
  type AIUsage
} from "./types";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

const STAGE_INSTRUCTIONS: Readonly<Record<AIStage, string>> = {
  intake_analysis: "Analyze the research brief, ambiguity, scope, freshness, completion criteria, and risks.",
  question_decomposition: "Decompose the approved core question into bounded research questions.",
  research_plan: "Create a source-first research plan for each supplied question.",
  source_summary: "Summarize only the supplied source and state its limitations.",
  evidence_extraction: "Extract minimal evidence spans and classify their stance without inventing facts.",
  claim_generation: "Propose claims supported by the supplied evidence and cite only allowed source IDs.",
  gap_detection: "Identify unanswered questions and unsupported research gaps.",
  conflict_detection: "Identify material conflicts between supplied sources without hiding disagreement.",
  report_outline: "Create an evidence-backed report outline tied to supplied claims and sources.",
  draft_generation: "Draft a report using only supplied claims. Format every inline citation as [@SOURCE_ID] and use only allowed source IDs.",
  qa_revision: "Recommend revisions for the supplied QA findings without silently removing limitations."
};

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface OpenAIResponsePayload {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  output_text?: unknown;
  output?: unknown;
  usage?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseText(payload: OpenAIResponsePayload): string | undefined {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  if (!Array.isArray(payload.output)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const rawItem of payload.output) {
    const item = record(rawItem);
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const rawContent of item.content) {
      const content = record(rawContent);
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function usageFrom(value: unknown): AIUsage | undefined {
  const usage = record(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : { inputTokens, outputTokens, totalTokens };
}

function strictJsonSchema(stage: AIStage): Record<string, unknown> {
  const generated = z.toJSONSchema(aiStageOutputSchemas[stage], {
    target: "draft-7",
    unrepresentable: "throw"
  }) as Record<string, unknown>;
  const schema = { ...generated };
  delete schema.$schema;
  return schema;
}

function validNonBlank(value: string, label: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return result;
}

function initialMetadata<Stage extends AIStage>(
  provider: OpenAIResponsesProvider,
  request: AIStageRequest<Stage>,
  startedAt: Date
): AIExecutionMetadata {
  return {
    provider: provider.id,
    model: provider.model,
    stage: request.stage,
    promptTemplateVersion: request.promptTemplateVersion,
    projectId: request.projectId,
    inputHash: inputHash(request.input),
    startedAt: startedAt.toISOString(),
    durationMs: 0
  };
}

export class OpenAIResponsesProvider implements AIProvider {
  readonly id = "openai-responses";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = validNonBlank(options.model ?? "gpt-5-mini", "OpenAI model", 128);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 4_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error("OpenAI timeout must be an integer between 1000 and 120000 ms");
    }
    if (
      !Number.isInteger(this.maxOutputTokens) ||
      this.maxOutputTokens < 128 ||
      this.maxOutputTokens > 32_000
    ) {
      throw new Error("OpenAI maxOutputTokens must be an integer between 128 and 32000");
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async run<Stage extends AIStage>(
    request: AIStageRequest<Stage>
  ): Promise<AIExecutionResult<Stage>> {
    const startedAt = this.now();
    const metadata = initialMetadata(this, request, startedAt);
    const finishMetadata = (
      additions: Partial<Pick<AIExecutionMetadata, "model" | "requestId" | "usage">> = {}
    ): AIExecutionMetadata => ({
      ...metadata,
      ...additions,
      durationMs: Math.max(0, this.now().getTime() - startedAt.getTime())
    });

    if (!this.apiKey) {
      return {
        success: false,
        error: { code: "NOT_CONFIGURED", message: "OpenAI is not configured" },
        metadata: finishMetadata()
      };
    }

    try {
      validNonBlank(request.projectId, "projectId", 512);
      validNonBlank(request.promptTemplateVersion, "promptTemplateVersion", 512);
      validateAllowedSourceIds(request.allowedSourceIds);
      if (unknownSourceIds(request.input, request.allowedSourceIds).length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_SOURCE_ID",
            message: "AI input referenced a source outside the allowlist"
          },
          metadata: finishMetadata()
        };
      }

      let response: Response;
      try {
        response = await this.fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: this.model,
            store: false,
            max_output_tokens: this.maxOutputTokens,
            instructions: `${EXTERNAL_CONTENT_INSTRUCTION}\n\n${STAGE_INSTRUCTIONS[request.stage]}`,
            input: stableJson({
              task: request.stage,
              allowedSourceIds: request.allowedSourceIds,
              externalContentAndInputs: request.input
            }),
            text: {
              format: {
                type: "json_schema",
                name: `research_${request.stage}`,
                strict: true,
                schema: strictJsonSchema(request.stage)
              }
            },
            metadata: {
              project_id: request.projectId,
              stage: request.stage,
              prompt_version: request.promptTemplateVersion
            }
          }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        const timeout =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");
        return {
          success: false,
          error: {
            code: timeout ? "TIMEOUT" : "PROVIDER_ERROR",
            message: timeout ? "OpenAI request timed out" : "OpenAI request failed"
          },
          metadata: finishMetadata()
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: "PROVIDER_ERROR",
            message: `OpenAI returned HTTP ${response.status}`
          },
          metadata: finishMetadata()
        };
      }

      let payload: OpenAIResponsePayload;
      try {
        payload = (await response.json()) as OpenAIResponsePayload;
      } catch {
        return {
          success: false,
          error: { code: "INVALID_RESPONSE", message: "OpenAI returned invalid JSON" },
          metadata: finishMetadata()
        };
      }
      const requestId = typeof payload.id === "string" ? payload.id : undefined;
      const responseModel = typeof payload.model === "string" ? payload.model : this.model;
      const usage = usageFrom(payload.usage);
      const responseMetadata = finishMetadata({
        model: responseModel,
        ...(requestId ? { requestId } : {}),
        ...(usage ? { usage } : {})
      });
      if (
        typeof payload.id !== "string" ||
        typeof payload.model !== "string" ||
        payload.status !== "completed"
      ) {
        return {
          success: false,
          error: {
            code: "PROVIDER_ERROR",
            message: "OpenAI response did not complete"
          },
          metadata: responseMetadata
        };
      }
      const text = responseText(payload);
      if (!text) {
        return {
          success: false,
          error: { code: "INVALID_RESPONSE", message: "OpenAI returned no output text" },
          metadata: responseMetadata
        };
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        return {
          success: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "OpenAI structured output was not valid JSON"
          },
          metadata: responseMetadata
        };
      }
      let output;
      try {
        output = parseStageOutput(request.stage, decoded);
      } catch {
        return {
          success: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "OpenAI structured output did not match the stage schema"
          },
          metadata: responseMetadata
        };
      }
      if (unknownSourceIds(output, request.allowedSourceIds).length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_SOURCE_ID",
            message: "OpenAI output referenced a source outside the allowlist"
          },
          metadata: responseMetadata
        };
      }
      return { success: true, output, metadata: responseMetadata };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "INVALID_RESPONSE",
          message: error instanceof Error ? error.message : "AI request was invalid"
        },
        metadata: finishMetadata()
      };
    }
  }
}

export { OPENAI_RESPONSES_ENDPOINT };
