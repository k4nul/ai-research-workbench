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
  classifyFetchFailure,
  composeAbortSignal,
  ProviderRequestError,
  readJsonWithLimit,
  retryAfterMs
} from "./execution";
import {
  aiStageOutputSchemas,
  type AIExecutionMetadata,
  type AIExecutionResult,
  type AIProvider,
  type AIStage,
  type AIStageRequest,
  type AIUsage,
  type ProviderExecutionOptions
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
  maxResponseBytes?: number;
  endpoint?: string;
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
  error?: unknown;
  incomplete_details?: unknown;
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

function containsRefusal(payload: OpenAIResponsePayload): boolean {
  if (!Array.isArray(payload.output)) {
    return false;
  }
  return payload.output.some((rawItem) => {
    const item = record(rawItem);
    return Array.isArray(item?.content) && item.content.some((rawContent) => {
      const content = record(rawContent);
      return content?.type === "refusal";
    });
  });
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
  private readonly maxResponseBytes: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = validNonBlank(options.model ?? "gpt-5-mini", "OpenAI model", 128);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 4_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.endpoint = options.endpoint ?? OPENAI_RESPONSES_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("OpenAI timeout must be an integer between 1000 and 120000 ms");
    }
    if (
      !Number.isInteger(this.maxOutputTokens) ||
      this.maxOutputTokens < 128 ||
      this.maxOutputTokens > 32_000
    ) {
      throw new Error("OpenAI maxOutputTokens must be an integer between 128 and 32000");
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 10_000_000
    ) {
      throw new Error("OpenAI maxResponseBytes must be an integer between 1024 and 10000000");
    }
    const endpoint = new URL(this.endpoint);
    if (
      endpoint.protocol !== "https:" &&
      endpoint.hostname !== "127.0.0.1" &&
      endpoint.hostname !== "localhost"
    ) {
      throw new Error(
        "OpenAI endpoint must use HTTPS except for a loopback contract-test server"
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async run<Stage extends AIStage>(
    request: AIStageRequest<Stage>,
    options: ProviderExecutionOptions = {}
  ): Promise<AIExecutionResult<Stage>> {
    const startedAt = this.now();
    const metadata = initialMetadata(this, request, startedAt);
    const finishMetadata = (
      additions: Partial<
        Pick<
          AIExecutionMetadata,
          "model" | "requestId" | "providerResponseId" | "usage"
        >
      > = {}
    ): AIExecutionMetadata => ({
      ...metadata,
      ...additions,
      durationMs: Math.max(0, this.now().getTime() - startedAt.getTime())
    });

    if (!this.apiKey) {
      return {
        success: false,
        error: {
          code: "NOT_CONFIGURED",
          message: "OpenAI is not configured",
          classification: "NON_RETRYABLE_USER_INPUT",
          retryable: false
        },
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
            message: "AI input referenced a source outside the allowlist",
            classification: "NON_RETRYABLE_SECURITY",
            retryable: false
          },
          metadata: finishMetadata()
        };
      }

      let response: Response;
      const abort = composeAbortSignal(this.timeoutMs, options.signal);
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...(options.clientRequestId
              ? { "X-Client-Request-Id": options.clientRequestId }
              : {})
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
          signal: abort.signal
        });
      } catch (error) {
        const classified = classifyFetchFailure(
          error,
          options.signal,
          abort.timeoutSignal
        );
        const cancelled = classified.classification === "CANCELLED";
        return {
          success: false,
          error: {
            code: cancelled
              ? "CANCELLED"
              : abort.timeoutSignal.aborted
                ? "TIMEOUT"
                : "PROVIDER_ERROR",
            message: classified.message.replace("Provider", "OpenAI"),
            classification: classified.classification,
            retryable: classified.retryable
          },
          metadata: finishMetadata()
        };
      }

      if (!response.ok) {
        const requestId = response.headers.get("x-request-id") ?? undefined;
        const retryDelay =
          response.status === 429 ? retryAfterMs(response.headers) : undefined;
        const rateLimited = response.status === 429;
        const serverError = response.status >= 500;
        return {
          success: false,
          error: {
            code: rateLimited
              ? "RATE_LIMITED"
              : serverError
                ? "SERVER_ERROR"
                : "PROVIDER_ERROR",
            message: `OpenAI returned HTTP ${response.status}`,
            classification: rateLimited
              ? "RETRYABLE_PROVIDER_RATE_LIMIT"
              : serverError
                ? "RETRYABLE_PROVIDER_SERVER_ERROR"
                : "NON_RETRYABLE_USER_INPUT",
            retryable: rateLimited || serverError,
            httpStatus: response.status,
            ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay })
          },
          metadata: finishMetadata(requestId ? { requestId } : {})
        };
      }

      let payload: OpenAIResponsePayload;
      try {
        payload = (await readJsonWithLimit(
          response,
          this.maxResponseBytes
        )) as OpenAIResponsePayload;
      } catch (error) {
        const tooLarge =
          error instanceof ProviderRequestError &&
          error.message.includes("byte limit");
        return {
          success: false,
          error: {
            code: tooLarge ? "RESPONSE_TOO_LARGE" : "INVALID_RESPONSE",
            message: tooLarge
              ? "OpenAI response exceeded the configured byte limit"
              : "OpenAI returned invalid JSON",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false,
            httpStatus: response.status
          },
          metadata: finishMetadata(
            response.headers.get("x-request-id")
              ? { requestId: response.headers.get("x-request-id") ?? undefined }
              : {}
          )
        };
      }
      const providerResponseId =
        typeof payload.id === "string" ? payload.id : undefined;
      const requestId =
        response.headers.get("x-request-id") ?? providerResponseId ?? undefined;
      const responseModel =
        typeof payload.model === "string" ? payload.model : this.model;
      const usage = usageFrom(payload.usage);
      const responseMetadata = finishMetadata({
        model: responseModel,
        ...(requestId ? { requestId } : {}),
        ...(providerResponseId ? { providerResponseId } : {}),
        ...(usage ? { usage } : {})
      });
      if (typeof payload.id !== "string" || typeof payload.model !== "string") {
        return {
          success: false,
          error: {
            code: "PROVIDER_ERROR",
            message: "OpenAI returned an invalid response envelope",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
          },
          metadata: responseMetadata
        };
      }
      if (payload.status === "completed" && containsRefusal(payload)) {
        return {
          success: false,
          error: {
            code: "REFUSED",
            message: "OpenAI refused the structured request",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
          },
          metadata: responseMetadata
        };
      }
      if (payload.status === "failed") {
        const providerError = record(payload.error);
        const providerErrorCode =
          typeof providerError?.code === "string" ? providerError.code : undefined;
        const rateLimited = providerErrorCode === "rate_limit_exceeded";
        const serverError = providerErrorCode === "server_error";
        const retryDelay = rateLimited ? retryAfterMs(response.headers) : undefined;
        return {
          success: false,
          error: {
            code: rateLimited
              ? "RATE_LIMITED"
              : serverError
                ? "SERVER_ERROR"
                : "PROVIDER_ERROR",
            message: rateLimited
              ? "OpenAI response generation was rate limited"
              : serverError
                ? "OpenAI response generation failed on the provider"
                : "OpenAI response generation failed",
            classification: rateLimited
              ? "RETRYABLE_PROVIDER_RATE_LIMIT"
              : serverError
                ? "RETRYABLE_PROVIDER_SERVER_ERROR"
                : "NON_RETRYABLE_VALIDATION",
            retryable: rateLimited || serverError,
            ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay })
          },
          metadata: responseMetadata
        };
      }
      if (payload.status !== "completed") {
        const incomplete = record(payload.incomplete_details);
        const contentFiltered = incomplete?.reason === "content_filter";
        const truncated = incomplete?.reason === "max_output_tokens";
        return {
          success: false,
          error: {
            code: contentFiltered
              ? "CONTENT_FILTERED"
              : truncated
                ? "TRUNCATED"
                : "PROVIDER_ERROR",
            message: contentFiltered
              ? "OpenAI response was blocked by content filtering"
              : truncated
                ? "OpenAI structured response was truncated"
                : "OpenAI response did not complete",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
          },
          metadata: responseMetadata
        };
      }
      const text = responseText(payload);
      if (!text) {
        return {
          success: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "OpenAI returned no output text",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
          },
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
            message: "OpenAI structured output was not valid JSON",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
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
            message: "OpenAI structured output did not match the stage schema",
            classification: "NON_RETRYABLE_VALIDATION",
            retryable: false
          },
          metadata: responseMetadata
        };
      }
      if (unknownSourceIds(output, request.allowedSourceIds).length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_SOURCE_ID",
            message: "OpenAI output referenced a source outside the allowlist",
            classification: "NON_RETRYABLE_SECURITY",
            retryable: false
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
          message: error instanceof Error ? error.message : "AI request was invalid",
          classification: "NON_RETRYABLE_VALIDATION",
          retryable: false
        },
        metadata: finishMetadata()
      };
    }
  }
}

export { OPENAI_RESPONSES_ENDPOINT };
