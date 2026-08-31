import { getConfig } from "@/lib/config";
import { query } from "@/lib/db";
import {
  checkRunBudget,
  estimateProviderCost,
  parseModelPrices,
  type BudgetSnapshot,
  type CostStatus,
  type ModelPrice,
  type RunUsage
} from "@/lib/budgets";
import { isRetryableJobError, type JobErrorClass } from "@/lib/domain/jobs";
import {
  MockAIProvider,
  OpenAIResponsesProvider,
  aiStageOutputSchemas,
  type AIExecutionResult,
  type AIProvider,
  type AIStage,
  type AIStageOutputMap,
  type AIStageRequest,
  type ProviderErrorClass
} from "@/lib/providers";
import { inputHash } from "@/lib/providers/ai-shared";
import {
  advanceResearchPipelineStage,
  buildResearchStageInput,
  commitResearchStageDomainEffects,
  loadResearchOrchestrationBundle,
  ResearchStageBlockedError,
  validateResearchStageOutputReferences,
  type ResearchOrchestrationBundle
} from "@/lib/services/research-orchestrator";
import {
  finishProviderExecution,
  startProviderExecution,
  type ProviderExecutionStatus
} from "@/lib/services/provider-executions";
import {
  acquireProviderPermit,
  releaseProviderPermit,
  type ProviderLimitPolicy
} from "@/lib/services/provider-limits";
import {
  assertRunStageJobFence,
  blockRunStage,
  commitRunStage,
  recordRunStageProviderAttempt,
  startRunStage,
  type RunStageJobFence
} from "@/lib/services/run-stages";
import type { ResearchRunRow } from "@/lib/services/research-runs";
import { JobExecutionError } from "@/worker/durable-worker";
import {
  registerJobHandler,
  registeredJobHandlers,
  type JobHandler,
  type JobHandlerContext
} from "@/worker/handlers";

export const RESEARCH_PIPELINE_STAGE_JOB = "RESEARCH_PIPELINE_STAGE";

const SYNTHETIC_EVALUATION_PROFILE = "synthetic-evaluation-v2";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SyntheticEvaluationProfile = {
  kind: typeof SYNTHETIC_EVALUATION_PROFILE;
  scopeId: string;
};

export function syntheticEvaluationProviderConfig(scopeId: string): {
  aiProvider: "mock-ai";
  internalExecutionProfile: SyntheticEvaluationProfile;
} {
  if (!UUID_V4_PATTERN.test(scopeId)) {
    throw new Error("Synthetic evaluation permit scope must be a UUIDv4.");
  }
  return {
    aiProvider: "mock-ai",
    internalExecutionProfile: {
      kind: SYNTHETIC_EVALUATION_PROFILE,
      scopeId
    }
  };
}

export function researchProviderPermitOperation(
  providerId: string,
  run: Pick<ResearchRunRow, "id" | "provider_config_snapshot">
): string {
  const profile = run.provider_config_snapshot.internalExecutionProfile;
  if (
    providerId !== "mock-ai" ||
    run.provider_config_snapshot.aiProvider !== "mock-ai" ||
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    Object.keys(profile).sort().join(",") !== "kind,scopeId"
  ) {
    return "ai.run";
  }
  const candidate = profile as Record<string, unknown>;
  if (
    candidate.kind !== SYNTHETIC_EVALUATION_PROFILE ||
    typeof candidate.scopeId !== "string" ||
    !UUID_V4_PATTERN.test(candidate.scopeId) ||
    !UUID_V4_PATTERN.test(run.id)
  ) {
    return "ai.run";
  }
  return `ai.run.synthetic-evaluation:${candidate.scopeId}:${run.id}`;
}

export type ResearchPipelineHandlerDependencies = {
  providerForRun?: (run: ResearchRunRow) => AIProvider;
  prices?: readonly ModelPrice[];
  permitPolicy?: ProviderLimitPolicy;
};

function snapshotText(
  snapshot: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function defaultProviderForRun(run: ResearchRunRow): AIProvider {
  const config = getConfig();
  const provider =
    snapshotText(run.provider_config_snapshot, "aiProvider", "provider", "ai") ??
    (config.demoMode || !config.openAiApiKey ? "mock-ai" : "openai-responses");
  const model =
    snapshotText(run.model_config_snapshot, "aiModel", "model") ??
    config.openAiModel;
  if (provider === "mock-ai") {
    return new MockAIProvider();
  }
  if (provider === "openai-responses") {
    const selected = new OpenAIResponsesProvider({
      apiKey: config.openAiApiKey,
      model,
      timeoutMs: config.fetchTimeoutMs
    });
    if (!selected.isConfigured()) {
      throw new ResearchStageBlockedError(
        "PROVIDER_NOT_CONFIGURED",
        "The provider frozen for this run is no longer configured.",
        "NON_RETRYABLE_USER_INPUT"
      );
    }
    return selected;
  }
  throw new ResearchStageBlockedError(
    "UNKNOWN_FROZEN_PROVIDER",
    `The provider frozen for this run is not supported: ${provider}.`,
    "NON_RETRYABLE_VALIDATION"
  );
}

function defaultPermitPolicy(): ProviderLimitPolicy {
  const config = getConfig();
  return {
    requestLimit: config.providerRequestLimit,
    windowSeconds: config.providerRequestWindowSeconds,
    concurrencyLimit: config.providerConcurrency,
    permitTtlMs: Math.min(
      3_600_000,
      Math.max(1_000, config.jobLeaseDurationMs, config.jobDefaultTimeoutMs)
    )
  };
}

function budgetSnapshot(run: ResearchRunRow): BudgetSnapshot {
  const stored = run.budget_snapshot as BudgetSnapshot & {
    maxEstimatedCost?: number;
  };
  const maxEstimatedCostUsd =
    stored.maxEstimatedCostUsd ?? stored.maxEstimatedCost;
  if (!Number.isFinite(maxEstimatedCostUsd)) {
    throw new ResearchStageBlockedError(
      "INVALID_RUN_BUDGET",
      "The frozen run budget has no valid maximum estimated cost.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  return {
    maxProviderRequests: stored.maxProviderRequests,
    maxSearchRequests: stored.maxSearchRequests,
    maxInputTokens: stored.maxInputTokens,
    maxOutputTokens: stored.maxOutputTokens,
    maxEstimatedCostUsd,
    maxElapsedMs: stored.maxElapsedMs,
    maxStageAttempts: stored.maxStageAttempts,
    maxSources: stored.maxSources,
    maxDocumentChunks: stored.maxDocumentChunks
  };
}

function numberValue(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function runUsage(bundle: ResearchOrchestrationBundle): RunUsage {
  return {
    providerRequests: bundle.run.total_provider_requests,
    searchRequests: bundle.run.total_search_requests,
    inputTokens: numberValue(bundle.run.total_input_tokens),
    outputTokens: numberValue(bundle.run.total_output_tokens),
    estimatedCostUsd: numberValue(bundle.run.estimated_cost),
    costStatus: bundle.run.cost_status,
    elapsedMs: bundle.run.started_at
      ? Math.max(0, Date.now() - new Date(bundle.run.started_at).getTime())
      : 0,
    stageAttempts: bundle.stage.attempt_count,
    sources: bundle.eligibleSources.length,
    documentChunks: bundle.documentChunkCount
  };
}

function configuredCostStatus(
  provider: AIProvider,
  prices: readonly ModelPrice[]
): CostStatus {
  return (
    prices.find(
      (price) => price.provider === provider.id && price.model === provider.model
    )?.status ?? "UNKNOWN"
  );
}

function providerErrorClass<Stage extends AIStage>(
  result: Extract<AIExecutionResult<Stage>, { success: false }>
): JobErrorClass {
  const classification = result.error.classification as
    | ProviderErrorClass
    | undefined;
  if (classification) {
    return classification === "UNKNOWN" ? "UNKNOWN" : classification;
  }
  switch (result.error.code) {
    case "RATE_LIMITED":
      return "RETRYABLE_PROVIDER_RATE_LIMIT";
    case "SERVER_ERROR":
      return "RETRYABLE_PROVIDER_SERVER_ERROR";
    case "TIMEOUT":
      return "RETRYABLE_TIMEOUT";
    case "CANCELLED":
      return "CANCELLED";
    case "UNKNOWN_SOURCE_ID":
      return "NON_RETRYABLE_SECURITY";
    case "INVALID_RESPONSE":
    case "REFUSED":
    case "CONTENT_FILTERED":
    case "TRUNCATED":
    case "RESPONSE_TOO_LARGE":
      return "NON_RETRYABLE_VALIDATION";
    case "NOT_CONFIGURED":
      return "NON_RETRYABLE_USER_INPUT";
    case "PROVIDER_ERROR":
      return result.error.retryable ? "RETRYABLE_NETWORK" : "UNKNOWN";
  }
}

function providerExecutionStatus<Stage extends AIStage>(
  result: Extract<AIExecutionResult<Stage>, { success: false }>
): ProviderExecutionStatus {
  switch (result.error.code) {
    case "CANCELLED":
      return "CANCELLED";
    case "TIMEOUT":
      return "TIMED_OUT";
    case "INVALID_RESPONSE":
    case "UNKNOWN_SOURCE_ID":
    case "REFUSED":
    case "CONTENT_FILTERED":
    case "TRUNCATED":
    case "RESPONSE_TOO_LARGE":
      return "REJECTED";
    default:
      return "FAILED";
  }
}

function abortedError(signal: AbortSignal, fallback: unknown): JobExecutionError {
  if (signal.reason instanceof JobExecutionError) {
    return signal.reason;
  }
  if (fallback instanceof JobExecutionError) {
    return fallback;
  }
  return new JobExecutionError(
    fallback instanceof Error ? fallback.message : "Provider execution was cancelled.",
    "CANCELLED"
  );
}

function abortedProviderExecutionStatus(
  errorClass: JobErrorClass
): ProviderExecutionStatus {
  return errorClass === "RETRYABLE_TIMEOUT" ? "TIMED_OUT" : "CANCELLED";
}

function providerProvenanceErrorClass(
  errorClass: JobErrorClass
): ProviderErrorClass {
  return errorClass === "RETRYABLE_STORAGE" || errorClass === "RETRYABLE_TIMEOUT"
    ? "UNKNOWN"
    : errorClass;
}

async function jobAttemptId(jobId: string, attempt: number): Promise<string | undefined> {
  const result = await query<{ id: string }>(
    "SELECT id FROM job_attempts WHERE job_id = $1 AND attempt_number = $2",
    [jobId, attempt]
  );
  return result.rows[0]?.id;
}

async function blockForBudget(
  bundle: ResearchOrchestrationBundle,
  violations: readonly string[],
  fence: RunStageJobFence
): Promise<never> {
  const reason = `Run budget prevents another provider call: ${violations.join(", ")}.`;
  await blockRunStage({
    runStageId: bundle.stage.id,
    fence,
    errorClass: "NON_RETRYABLE_BUDGET",
    reason
  });
  throw new JobExecutionError(reason, "NON_RETRYABLE_BUDGET");
}

async function failTerminalProviderAttempt(input: {
  bundle: ResearchOrchestrationBundle;
  job: JobHandlerContext["job"];
  fence: RunStageJobFence;
  errorClass: JobErrorClass;
  error: unknown;
}): Promise<void> {
  if (
    !isRetryableJobError(input.errorClass) ||
    input.job.attempts >= input.job.max_attempts
  ) {
    if (input.errorClass === "NON_RETRYABLE_BUDGET") {
      await blockRunStage({
        runStageId: input.bundle.stage.id,
        fence: input.fence,
        errorClass: input.errorClass,
        reason: input.error
      });
    }
  }
}

async function reuseOrCommitOutput(input: {
  bundle: ResearchOrchestrationBundle;
  fence: RunStageJobFence;
  output: AIStageOutputMap[AIStage];
}): Promise<unknown> {
  await commitRunStage({
    runStageId: input.bundle.stage.id,
    fence: input.fence,
    idempotencyKey: `run:${input.bundle.run.id}:stage:${input.bundle.stage.stage_id}:generation:${input.bundle.stage.generation}:commit`,
    outputReference: input.output,
    domainCommit: (client) =>
      commitResearchStageDomainEffects(client, input.bundle, input.output)
  });
  const advancement = await advanceResearchPipelineStage({
    runStageId: input.bundle.stage.id,
    fence: input.fence,
    output: input.output
  });
  return {
    runId: input.bundle.run.id,
    runStageId: input.bundle.stage.id,
    stage: input.bundle.stage.stage_id,
    generation: input.bundle.stage.generation,
    outputHash: inputHash(input.output),
    ...advancement
  };
}

export function createResearchPipelineStageHandler(
  dependencies: ResearchPipelineHandlerDependencies = {}
): JobHandler {
  return async ({ job, signal, workerId }: JobHandlerContext): Promise<unknown> => {
    if (!job.run_id || !job.run_stage_id || !job.stage) {
      throw new JobExecutionError(
        "A research pipeline job must reference a run and stage.",
        "NON_RETRYABLE_VALIDATION"
      );
    }
    const fence: RunStageJobFence = {
      jobId: job.id,
      runStageId: job.run_stage_id,
      attempt: job.attempts,
      workerId
    };
    let bundle = await loadResearchOrchestrationBundle(job.run_stage_id);
    if (
      bundle.run.id !== job.run_id ||
      bundle.stage.stage_id !== job.stage ||
      bundle.stage.id !== job.run_stage_id
    ) {
      throw new JobExecutionError(
        "The job references do not match the stored research run stage.",
        "NON_RETRYABLE_SECURITY"
      );
    }
    if (bundle.stage.status === "SUCCEEDED" && bundle.stage.output_reference !== null) {
      const output = aiStageOutputSchemas[bundle.stage.stage_id as AIStage].parse(
        bundle.stage.output_reference
      ) as AIStageOutputMap[AIStage];
      await advanceResearchPipelineStage({
        runStageId: bundle.stage.id,
        fence,
        output
      });
      return {
        runId: bundle.run.id,
        runStageId: bundle.stage.id,
        stage: bundle.stage.stage_id,
        generation: bundle.stage.generation,
        outputHash: bundle.stage.output_hash,
        replayed: true
      };
    }
    try {
      await startRunStage(bundle.stage.id, fence);
      bundle = await loadResearchOrchestrationBundle(bundle.stage.id);
      if (bundle.stage.output_reference !== null && bundle.stage.output_hash) {
        const output = aiStageOutputSchemas[bundle.stage.stage_id as AIStage].parse(
          bundle.stage.output_reference
        ) as AIStageOutputMap[AIStage];
        return reuseOrCommitOutput({ bundle, fence, output });
      }
      const built = buildResearchStageInput(bundle);
      const provider = (dependencies.providerForRun ?? defaultProviderForRun)(bundle.run);
      const prices =
        dependencies.prices ?? parseModelPrices(getConfig().modelPricingJson);
      const costStatus = configuredCostStatus(provider, prices);
      const beforeUsage = runUsage(bundle);
      const preflight = checkRunBudget(
        budgetSnapshot(bundle.run),
        beforeUsage,
        { providerRequests: 1, costStatus }
      );
      if (!preflight.allowed) {
        return blockForBudget(bundle, preflight.violations, fence);
      }
      const permitOwner = `${job.id}:${job.attempts}`;
      const permit = await acquireProviderPermit({
        provider: provider.id,
        operation: researchProviderPermitOperation(provider.id, bundle.run),
        ownerId: permitOwner,
        jobId: job.id,
        policy: dependencies.permitPolicy ?? defaultPermitPolicy()
      });
      if (!permit.allowed) {
        const error = new JobExecutionError(
          `Provider capacity is temporarily unavailable (${permit.reason}).`,
          "RETRYABLE_PROVIDER_RATE_LIMIT",
          permit.retryAfterMs
        );
        await failTerminalProviderAttempt({
          bundle,
          job,
          fence,
          errorClass: error.errorClass,
          error
        });
        throw error;
      }
      const clientRequestId = `${bundle.run.id}:${bundle.stage.id}:${bundle.stage.generation}:${job.attempts}`;
      const providerInputHash = inputHash(built.input);
      let executionId: string | undefined;
      let result: AIExecutionResult<AIStage>;
      const providerStartedAt = Date.now();
      try {
        await assertRunStageJobFence(bundle.stage.id, fence);
        if (signal.aborted) {
          throw abortedError(signal, signal.reason);
        }
        executionId = await startProviderExecution({
          projectId: bundle.run.project_id,
          runId: bundle.run.id,
          runStageId: bundle.stage.id,
          jobId: job.id,
          jobAttemptId: await jobAttemptId(job.id, job.attempts),
          provider: provider.id,
          model: provider.model,
          operation: `ai.${built.stage}`,
          clientRequestId,
          promptTemplateVersion: bundle.stage.prompt_template_version,
          structuredSchemaVersion: bundle.stage.structured_schema_version,
          inputHash: providerInputHash,
          retryCount: Math.max(0, job.attempts - 1)
        });
        const request: AIStageRequest<AIStage> = {
          stage: built.stage,
          projectId: bundle.run.project_id,
          promptTemplateVersion: bundle.stage.prompt_template_version,
          input: built.input,
          allowedSourceIds: built.allowedSourceIds
        };
        result = await provider.run(request, {
          signal,
          clientRequestId,
          jobId: job.id,
          runId: bundle.run.id,
          attempt: job.attempts
        });
        if (signal.aborted) {
          throw abortedError(signal, signal.reason);
        }
      } catch (cause) {
        const error = signal.aborted
          ? abortedError(signal, cause)
          : cause instanceof JobExecutionError
            ? cause
            : new JobExecutionError(
                cause instanceof Error ? cause.message : "Provider execution failed.",
                "RETRYABLE_NETWORK"
              );
        const errorClass = error.errorClass;
        if (executionId) {
          await finishProviderExecution({
            id: executionId,
            status: signal.aborted
              ? abortedProviderExecutionStatus(errorClass)
              : "FAILED",
            costStatus: "UNKNOWN",
            estimatedCostUsd: null,
            errorClass: providerProvenanceErrorClass(errorClass),
            sanitizedError: error.message
          });
          await recordRunStageProviderAttempt({
            runStageId: bundle.stage.id,
            fence,
            providerExecutionId: executionId,
            inputHash: providerInputHash,
            provider: provider.id,
            model: provider.model,
            usage: {},
            costStatus: "UNKNOWN",
            estimatedCostUsd: null,
            durationMs: Math.max(0, Date.now() - providerStartedAt),
            errorClass,
            error
          });
        }
        await failTerminalProviderAttempt({
          bundle,
          job,
          fence,
          errorClass,
          error
        });
        throw error;
      } finally {
        await releaseProviderPermit({
          permitId: permit.permitId,
          ownerId: permitOwner
        });
      }
      if (!executionId) {
        throw new JobExecutionError(
          "Provider provenance was not created.",
          "UNKNOWN"
        );
      }
      const usage =
        result.metadata.usage ??
        (provider.id === "mock-ai"
          ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
          : {});
      const cost = estimateProviderCost({
        provider: provider.id,
        model: provider.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        prices
      });
      if (!result.success) {
        const errorClass = providerErrorClass(result);
        await finishProviderExecution({
          id: executionId,
          status: providerExecutionStatus(result),
          requestId: result.metadata.requestId,
          providerResponseId: result.metadata.providerResponseId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          costStatus: cost.status,
          estimatedCostUsd: cost.estimatedCostUsd,
          errorClass: providerProvenanceErrorClass(errorClass),
          sanitizedError: result.error.message
        });
        await recordRunStageProviderAttempt({
          runStageId: bundle.stage.id,
          fence,
          providerExecutionId: executionId,
          inputHash: providerInputHash,
          provider: provider.id,
          model: provider.model,
          usage,
          costStatus: cost.status,
          estimatedCostUsd: cost.estimatedCostUsd,
          durationMs: result.metadata.durationMs,
          errorClass,
          error: result.error.message
        });
        const error = new JobExecutionError(
          result.error.message,
          errorClass,
          result.error.retryAfterMs
        );
        await failTerminalProviderAttempt({
          bundle,
          job,
          fence,
          errorClass,
          error
        });
        throw error;
      }
      let output: AIStageOutputMap[AIStage];
      try {
        output = aiStageOutputSchemas[built.stage].parse(
          result.output
        ) as AIStageOutputMap[AIStage];
        validateResearchStageOutputReferences(bundle, output);
      } catch (cause) {
        const error = new JobExecutionError(
          cause instanceof Error
            ? cause.message
            : "Provider output contained invalid domain references.",
          "NON_RETRYABLE_VALIDATION"
        );
        await finishProviderExecution({
          id: executionId,
          status: "REJECTED",
          requestId: result.metadata.requestId,
          providerResponseId: result.metadata.providerResponseId,
          outputHash: inputHash(result.output),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          costStatus: cost.status,
          estimatedCostUsd: cost.estimatedCostUsd,
          errorClass: "NON_RETRYABLE_VALIDATION",
          sanitizedError: error.message
        });
        await recordRunStageProviderAttempt({
          runStageId: bundle.stage.id,
          fence,
          providerExecutionId: executionId,
          inputHash: providerInputHash,
          provider: provider.id,
          model: provider.model,
          usage,
          costStatus: cost.status,
          estimatedCostUsd: cost.estimatedCostUsd,
          durationMs: result.metadata.durationMs,
          errorClass: error.errorClass,
          error
        });
        await failTerminalProviderAttempt({
          bundle,
          job,
          fence,
          errorClass: error.errorClass,
          error
        });
        throw error;
      }
      const finished = await finishProviderExecution({
        id: executionId,
        status: "SUCCEEDED",
        requestId: result.metadata.requestId,
        providerResponseId: result.metadata.providerResponseId,
        outputHash: inputHash(output),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costStatus: cost.status,
        estimatedCostUsd: cost.estimatedCostUsd
      });
      if (finished.duplicateOf) {
        const error = new JobExecutionError(
          "The provider response ID was already committed by another execution.",
          "NON_RETRYABLE_VALIDATION"
        );
        await recordRunStageProviderAttempt({
          runStageId: bundle.stage.id,
          fence,
          providerExecutionId: executionId,
          inputHash: providerInputHash,
          provider: provider.id,
          model: provider.model,
          usage,
          costStatus: cost.status,
          estimatedCostUsd: cost.estimatedCostUsd,
          durationMs: result.metadata.durationMs,
          errorClass: error.errorClass,
          error
        });
        await failTerminalProviderAttempt({
          bundle,
          job,
          fence,
          errorClass: error.errorClass,
          error
        });
        throw error;
      }
      await recordRunStageProviderAttempt({
        runStageId: bundle.stage.id,
        fence,
        providerExecutionId: executionId,
        inputHash: providerInputHash,
        provider: provider.id,
        model: provider.model,
        usage,
        costStatus: cost.status,
        estimatedCostUsd: cost.estimatedCostUsd,
        durationMs: result.metadata.durationMs,
        outputReference: output
      });
      const postflight = checkRunBudget(
        budgetSnapshot(bundle.run),
        beforeUsage,
        {
          providerRequests: 1,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          estimatedCostUsd: cost.estimatedCostUsd ?? 0,
          elapsedMs: result.metadata.durationMs,
          costStatus: cost.status
        }
      );
      if (!postflight.allowed) {
        return blockForBudget(bundle, postflight.violations, fence);
      }
      return reuseOrCommitOutput({ bundle, fence, output });
    } catch (error) {
      if (error instanceof ResearchStageBlockedError) {
        await blockRunStage({
          runStageId: bundle.stage.id,
          fence,
          errorClass: error.errorClass,
          reason: `${error.code}: ${error.message}`
        });
        throw new JobExecutionError(error.message, error.errorClass);
      }
      throw error;
    }
  };
}

export function registerResearchPipelineStageHandler(): void {
  if (registeredJobHandlers().has(RESEARCH_PIPELINE_STAGE_JOB)) {
    return;
  }
  registerJobHandler(
    RESEARCH_PIPELINE_STAGE_JOB,
    createResearchPipelineStageHandler()
  );
}
