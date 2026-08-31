import { ZodError } from "zod";
import { getConfig } from "@/lib/config";
import type { JobErrorClass } from "@/lib/domain/jobs";
import {
  BraveSearchProvider,
  MockSearchProvider,
  ProviderRequestError,
  type ProviderErrorClass,
  type SearchProvider
} from "@/lib/providers";
import { SafeFetchError } from "@/lib/security";
import {
  commitSourceSearchResults,
  parseSourceSearchJob,
  reserveSourceSearchAttempt,
  reuseCommittedSourceSearchResults,
  SOURCE_SEARCH_JOB,
  SourceSearchJobError,
  type SourceSearchJobPayload
} from "@/lib/services/source-search-jobs";
import {
  finishProviderExecution,
  type ProviderExecutionStatus
} from "@/lib/services/provider-executions";
import {
  acquireProviderPermit,
  releaseProviderPermit,
  type ProviderLimitPolicy
} from "@/lib/services/provider-limits";
import { JobExecutionError } from "@/worker/durable-worker";
import {
  registerJobHandler,
  registeredJobHandlers,
  type JobHandler
} from "@/worker/handlers";

export type SourceSearchHandlerDependencies = {
  providerForJob?: (payload: SourceSearchJobPayload) => SearchProvider;
  permitPolicy?: ProviderLimitPolicy;
};

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

function defaultProviderForJob(payload: SourceSearchJobPayload): SearchProvider {
  if (payload.providerId === "mock-search") {
    return new MockSearchProvider();
  }
  if (payload.providerId === "brave-search") {
    const config = getConfig();
    const provider = new BraveSearchProvider({
      apiKey: config.braveSearchApiKey,
      timeoutMs: config.fetchTimeoutMs
    });
    if (!provider.isConfigured()) {
      throw new SourceSearchJobError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "The search provider frozen for this job is no longer configured.",
        "NON_RETRYABLE_USER_INPUT"
      );
    }
    return provider;
  }
  throw new SourceSearchJobError(
    "UNKNOWN_SEARCH_PROVIDER",
    `The frozen search provider is not supported: ${payload.providerId}.`,
    "NON_RETRYABLE_VALIDATION"
  );
}

export function sourceSearchExecutionError(
  error: unknown,
  signal?: AbortSignal
): JobExecutionError {
  if (signal?.aborted && signal.reason instanceof JobExecutionError) {
    return signal.reason;
  }
  if (error instanceof JobExecutionError) {
    return error;
  }
  if (error instanceof SourceSearchJobError) {
    return new JobExecutionError(error.message, error.errorClass);
  }
  if (error instanceof ProviderRequestError) {
    const errorClass =
      error.classification === "RETRYABLE_NETWORK" &&
      /timed out/i.test(error.message)
        ? "RETRYABLE_TIMEOUT"
        : error.classification;
    return new JobExecutionError(
      error.message,
      errorClass,
      error.retryAfterMs
    );
  }
  if (error instanceof SafeFetchError) {
    return new JobExecutionError(error.message, "NON_RETRYABLE_SECURITY");
  }
  if (error instanceof ZodError || error instanceof TypeError) {
    return new JobExecutionError(
      error instanceof Error ? error.message : "Search data validation failed.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  if (signal?.aborted) {
    return new JobExecutionError("Source search was cancelled.", "CANCELLED");
  }
  return new JobExecutionError(
    error instanceof Error ? error.message : "Search provider execution failed.",
    "RETRYABLE_NETWORK"
  );
}

function providerErrorClass(errorClass: JobErrorClass): ProviderErrorClass {
  switch (errorClass) {
    case "RETRYABLE_PROVIDER_RATE_LIMIT":
    case "RETRYABLE_PROVIDER_SERVER_ERROR":
    case "RETRYABLE_NETWORK":
    case "NON_RETRYABLE_VALIDATION":
    case "NON_RETRYABLE_SECURITY":
    case "NON_RETRYABLE_BUDGET":
    case "NON_RETRYABLE_USER_INPUT":
    case "CANCELLED":
      return errorClass;
    case "RETRYABLE_TIMEOUT":
      return "RETRYABLE_NETWORK";
    default:
      return "UNKNOWN";
  }
}

function providerExecutionStatus(
  errorClass: JobErrorClass
): ProviderExecutionStatus {
  if (errorClass === "CANCELLED") {
    return "CANCELLED";
  }
  if (errorClass === "RETRYABLE_TIMEOUT") {
    return "TIMED_OUT";
  }
  if (errorClass.startsWith("NON_RETRYABLE_")) {
    return "REJECTED";
  }
  return "FAILED";
}

export function createSourceSearchHandler(
  dependencies: SourceSearchHandlerDependencies = {}
): JobHandler {
  return async ({ job, workerId, signal }) => {
    const payload = parseSourceSearchJob(job);
    if (signal.aborted) {
      throw sourceSearchExecutionError(signal.reason, signal);
    }
    const checkpoint = await reuseCommittedSourceSearchResults({ job, workerId });
    if (checkpoint) {
      if (signal.aborted) {
        throw sourceSearchExecutionError(signal.reason, signal);
      }
      return checkpoint;
    }
    const provider = (dependencies.providerForJob ?? defaultProviderForJob)(payload);
    if (provider.id !== payload.providerId) {
      throw new JobExecutionError(
        "The configured search provider does not match the frozen job provider.",
        "NON_RETRYABLE_SECURITY"
      );
    }
    if (!provider.isConfigured()) {
      throw new JobExecutionError(
        "The configured search provider is unavailable.",
        "NON_RETRYABLE_USER_INPUT"
      );
    }
    const permitOwner = `${job.id}:${job.attempts}`;
    const permit = await acquireProviderPermit({
      provider: provider.id,
      operation: "search.web",
      ownerId: permitOwner,
      jobId: job.id,
      policy: dependencies.permitPolicy ?? defaultPermitPolicy()
    });
    if (!permit.allowed) {
      throw new JobExecutionError(
        `Search provider capacity is temporarily unavailable (${permit.reason}).`,
        "RETRYABLE_PROVIDER_RATE_LIMIT",
        permit.retryAfterMs
      );
    }
    let executionId: string | undefined;
    let executionFinished = false;
    try {
      const reserved = await reserveSourceSearchAttempt({ job, workerId });
      executionId = reserved.executionId;
      if (signal.aborted) {
        throw sourceSearchExecutionError(signal.reason, signal);
      }
      const response = await provider.search(payload.request, {
        signal,
        clientRequestId: reserved.clientRequestId,
        jobId: job.id,
        runId: payload.runId,
        attempt: job.attempts
      });
      if (signal.aborted) {
        throw sourceSearchExecutionError(signal.reason, signal);
      }
      const output = await commitSourceSearchResults({
        job,
        workerId,
        executionId,
        response,
        signal
      });
      executionFinished = true;
      return output;
    } catch (cause) {
      const error = sourceSearchExecutionError(cause, signal);
      if (executionId && !executionFinished) {
        await finishProviderExecution({
          id: executionId,
          status: providerExecutionStatus(error.errorClass),
          costStatus: "UNKNOWN",
          estimatedCostUsd: null,
          errorClass: providerErrorClass(error.errorClass),
          sanitizedError: error.message,
          ...(cause instanceof ProviderRequestError && cause.requestId
            ? { requestId: cause.requestId }
            : {})
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      await releaseProviderPermit({
        permitId: permit.permitId,
        ownerId: permitOwner
      });
    }
  };
}

export function registerSourceSearchHandler(): void {
  if (registeredJobHandlers().has(SOURCE_SEARCH_JOB)) {
    return;
  }
  registerJobHandler(SOURCE_SEARCH_JOB, createSourceSearchHandler());
}
