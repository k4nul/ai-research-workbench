import { ZodError } from "zod";

import { generateArtifact } from "@/lib/export/generate";
import { StorageError } from "@/lib/storage";
import { AppError } from "@/lib/services/errors";
import {
  EXPORT_JOB_TYPE,
  ExportJobError,
  parseExportJob
} from "@/lib/services/export-jobs";
import type { ExportStorageRuntime } from "@/lib/services/export-storage";
import { JobExecutionError } from "@/worker/durable-worker";
import {
  registerJobHandler,
  registeredJobHandlers,
  type JobHandler
} from "@/worker/handlers";

export type ExportJobHandlerDependencies = {
  generate?: typeof generateArtifact;
  runtime?: ExportStorageRuntime;
};

export function exportExecutionError(
  error: unknown,
  signal?: AbortSignal
): Error {
  if (signal?.aborted) {
    return signal.reason instanceof JobExecutionError
      ? signal.reason
      : new JobExecutionError("Export generation was cancelled.", "CANCELLED");
  }
  if (error instanceof JobExecutionError) return error;
  if (error instanceof ExportJobError) {
    return new JobExecutionError(error.message, error.errorClass);
  }
  if (error instanceof ZodError) {
    return new JobExecutionError(
      "Export job input is invalid.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  if (error instanceof StorageError) {
    return new JobExecutionError(error.message, "RETRYABLE_STORAGE");
  }
  if (error instanceof AppError) {
    if (error.code === "EXPORT_JOB_CANCELLED") {
      return new JobExecutionError(error.message, "CANCELLED");
    }
    if (error.code === "EXPORT_CLEANUP_BUSY") {
      return new JobExecutionError(error.message, "RETRYABLE_STORAGE");
    }
    if (error.code === "JOB_LEASE_LOST") return error;
    return new JobExecutionError(
      error.message,
      ["APPROVAL_REQUIRED", "QA_BLOCKED", "NO_DELIVERABLE", "EXPORT_STALE"].includes(
        error.code
      )
        ? "NON_RETRYABLE_USER_INPUT"
        : "NON_RETRYABLE_VALIDATION"
    );
  }
  return error instanceof Error
    ? error
    : new Error("Export generation failed.");
}

export function createExportJobHandler(
  dependencies: ExportJobHandlerDependencies = {}
): JobHandler {
  const generate = dependencies.generate ?? generateArtifact;
  return async ({ job, workerId, signal }) => {
    try {
      signal.throwIfAborted();
      const payload = parseExportJob(job);
      const artifact = await generate(payload.projectId, payload.format, {
        persist: true,
        requireApproval: payload.requireApproval,
        expectedSnapshot: payload.snapshot,
        signal,
        execution: {
          jobId: job.id,
          workerId,
          attempt: job.attempts,
          signal,
          requestedBy: payload.requestedBy
        },
        ...(dependencies.runtime
          ? {
              storage: dependencies.runtime.storage,
              storageBucket: dependencies.runtime.bucket,
              maxObjectBytes: dependencies.runtime.maxObjectBytes
            }
          : {})
      });
      signal.throwIfAborted();
      if (!artifact.persisted) {
        throw new JobExecutionError(
          "The export artifact was not persisted.",
          "NON_RETRYABLE_VALIDATION"
        );
      }
      return {
        projectId: payload.projectId,
        format: payload.format,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        contentHash: payload.snapshot.contentHash,
        ...artifact.persisted,
        workerId,
        attempt: job.attempts,
        requestedBy: payload.requestedBy
      };
    } catch (error) {
      throw exportExecutionError(error, signal);
    }
  };
}

export function registerExportJobHandler(): void {
  if (registeredJobHandlers().has(EXPORT_JOB_TYPE)) return;
  registerJobHandler(EXPORT_JOB_TYPE, createExportJobHandler());
}
