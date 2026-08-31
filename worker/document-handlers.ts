import { z, ZodError } from "zod";
import { getConfig } from "@/lib/config";
import {
  getDocumentRuntime,
  type DocumentRuntime
} from "@/lib/documents/runtime";
import { StorageError } from "@/lib/storage";
import {
  DOCUMENT_JOB_TYPES,
  enqueueDocumentExtraction
} from "@/lib/services/document-jobs";
import {
  extractDocument,
  getDocumentProcessingState,
  scanDocument,
  type DocumentActor,
  type DocumentJobFence
} from "@/lib/services/documents";
import { AppError } from "@/lib/services/errors";
import {
  cleanupOrphanObjects,
  PostgresStorageObjectCatalog
} from "@/lib/services/orphan-cleanup";
import {
  registerJobHandler,
  type JobHandler,
  type JobHandlerContext
} from "@/worker/handlers";
import { JobExecutionError } from "@/worker/durable-worker";

const documentIdSchema = z.string().uuid();
const scanInputSchema = z
  .object({
    documentId: documentIdSchema,
    expectedObjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
    autoExtract: z.boolean()
  })
  .strict();
const extractInputSchema = z
  .object({
    documentId: documentIdSchema,
    expectedObjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedExtractionId: z.string().uuid().nullable()
  })
  .strict();
const cleanupInputSchema = z
  .object({
    objectIds: z.array(z.string().min(1).max(500)).optional(),
    prefix: z.enum(["debug", "evaluations", "exports", "extractions", "quarantine", "sources"]).optional(),
    graceMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1_000).optional(),
    leaseSeconds: z.number().int().min(1).max(3_600).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    deleteUntracked: z.boolean().default(false)
  })
  .strict();

function actor(jobId: string): DocumentActor {
  return {
    actorType: "SYSTEM",
    actorId: jobId,
    label: "Document worker"
  };
}

function projectId(context: JobHandlerContext): string {
  if (!context.job.project_id) {
    throw new JobExecutionError(
      "Document jobs require a project.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  return context.job.project_id;
}

function jobFence(context: JobHandlerContext): DocumentJobFence {
  return {
    jobId: context.job.id,
    workerId: context.workerId,
    attempt: context.job.attempts,
    version: context.job.version
  };
}

function rethrowJobError(error: unknown): never {
  if (error instanceof JobExecutionError) throw error;
  if (error instanceof AppError && error.code === "JOB_LEASE_LOST") throw error;
  if (error instanceof ZodError) {
    throw new JobExecutionError(
      "Document job input is invalid.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  if (error instanceof StorageError) {
    throw new JobExecutionError(error.message, "RETRYABLE_STORAGE");
  }
  if (error instanceof AppError && error.status < 500) {
    const security = [
      "DOCUMENT_INTEGRITY_PENDING",
      "STORAGE_INTEGRITY_FAILED",
      "STORAGE_PROVIDER_MISMATCH"
    ].includes(error.code);
    throw new JobExecutionError(
      error.message,
      security ? "NON_RETRYABLE_SECURITY" : "NON_RETRYABLE_VALIDATION"
    );
  }
  throw error;
}

function assertExpectedObject(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new JobExecutionError(
      "Document object identity changed after job submission.",
      "NON_RETRYABLE_SECURITY"
    );
  }
}

export function createDocumentJobHandlers(
  runtime: DocumentRuntime
): ReadonlyMap<string, JobHandler> {
  const scan: JobHandler = async (context) => {
    try {
      context.signal.throwIfAborted();
      const input = scanInputSchema.parse(context.job.input_reference);
      const scopedProjectId = projectId(context);
      let state = await getDocumentProcessingState(scopedProjectId, input.documentId);
      assertExpectedObject(state.objectSha256, input.expectedObjectSha256);

      let status = state.status;
      let scanStatus = state.scanStatus;
      let bypassed = false;
      if (["QUARANTINED", "BLOCKED_SCANNER_UNAVAILABLE", "SCANNING"].includes(state.status)) {
        const result = await scanDocument(
          scopedProjectId,
          input.documentId,
          runtime.storage,
          runtime.scanner,
          {
            maxBytes: runtime.maxScanBytes,
            production: runtime.production,
            allowExplicitDemoBypass: runtime.allowExplicitDemoBypass,
            resumeInProgress: state.status === "SCANNING",
            signal: context.signal,
            actor: actor(context.job.id),
            jobFence: jobFence(context)
          }
        );
        status = result.status;
        scanStatus = result.scan.status;
        bypassed = result.bypassed;
        state = await getDocumentProcessingState(scopedProjectId, input.documentId);
      } else if (state.scanStatus !== "CLEAN" && state.scanStatus !== "INFECTED") {
        throw new JobExecutionError(
          "Document is not in a replayable scan state.",
          "NON_RETRYABLE_VALIDATION"
        );
      }

      let extractionJob = null;
      if (input.autoExtract && state.scanStatus === "CLEAN" && state.status === "CLEAN") {
        context.signal.throwIfAborted();
        extractionJob = await enqueueDocumentExtraction({
          projectId: scopedProjectId,
          documentId: input.documentId,
          idempotencyKey: `after-scan:${context.job.id}`,
          actor: actor(context.job.id),
          parentJobId: context.job.id,
          correlationId: context.job.correlation_id,
          parentJobFence: jobFence(context)
        });
      }
      return {
        documentId: input.documentId,
        status,
        scanStatus,
        bypassed,
        extractionJob
      };
    } catch (error) {
      rethrowJobError(error);
    }
  };

  const extract: JobHandler = async (context) => {
    try {
      context.signal.throwIfAborted();
      const input = extractInputSchema.parse(context.job.input_reference);
      const scopedProjectId = projectId(context);
      const state = await getDocumentProcessingState(scopedProjectId, input.documentId);
      assertExpectedObject(state.objectSha256, input.expectedObjectSha256);
      if (
        state.currentExtractionId !== input.expectedExtractionId &&
        ["READY", "OCR_REQUIRED_UNSUPPORTED"].includes(state.status)
      ) {
        return {
          documentId: input.documentId,
          status: state.status,
          extractionId: state.currentExtractionId,
          replayed: true
        };
      }
      const result = await extractDocument(
        scopedProjectId,
        input.documentId,
        runtime.storage,
        {
          maxBytes: runtime.maxObjectBytes,
          production: runtime.production,
          allowExplicitDemoBypass: runtime.allowExplicitDemoBypass,
          resumeInProgress: state.status === "EXTRACTING",
          signal: context.signal,
          actor: actor(context.job.id),
          jobFence: jobFence(context)
        }
      );
      return { documentId: input.documentId, ...result, replayed: false };
    } catch (error) {
      rethrowJobError(error);
    }
  };

  const cleanup: JobHandler = async (context) => {
    try {
      context.signal.throwIfAborted();
      const input = cleanupInputSchema.parse(context.job.input_reference);
      const catalog = new PostgresStorageObjectCatalog();
      const totals = {
        batches: 0,
        deletedTracked: 0,
        deletedUntracked: 0,
        skippedRecentUntracked: 0
      };
      const cleanupBatch = async (deleteUntracked: boolean) => {
        context.signal.throwIfAborted();
        const report = await cleanupOrphanObjects({
          storage: runtime.storage,
          catalog,
          bucket: runtime.storageBucket,
          legacyStorageRoot: getConfig().storageDir,
          objectIds: input.objectIds,
          prefix: input.prefix,
          owner: `storage-cleanup:${context.job.id}:${context.job.attempts}:${context.workerId}`,
          graceMs: input.graceMs,
          leaseSeconds: input.leaseSeconds,
          limit: input.limit,
          deleteUntracked,
          signal: context.signal
        });
        totals.batches += 1;
        totals.deletedTracked += report.deletedTrackedIds.length;
        totals.deletedUntracked += report.deletedUntrackedCount;
        totals.skippedRecentUntracked += report.skippedRecentUntrackedCount;
        context.signal.throwIfAborted();
        if (report.failedTracked.length > 0) {
          throw new JobExecutionError(
            `Storage cleanup could not reconcile ${report.failedTracked.length} tracked object(s).`,
            "RETRYABLE_STORAGE"
          );
        }
        return report;
      };
      while (true) {
        const report = await cleanupBatch(false);
        if (report.remainingTrackedCount === 0) {
          break;
        }
        if (report.deletedTrackedIds.length === 0) {
          throw new JobExecutionError(
            `Storage cleanup is waiting for ${report.remainingTrackedCount} tracked object(s).`,
            "RETRYABLE_STORAGE"
          );
        }
      }
      if (input.deleteUntracked) {
        const report = await cleanupBatch(true);
        if (report.remainingTrackedCount > 0) {
          throw new JobExecutionError(
            `Storage cleanup discovered ${report.remainingTrackedCount} pending tracked object(s) during untracked reconciliation.`,
            "RETRYABLE_STORAGE"
          );
        }
      }
      return totals;
    } catch (error) {
      rethrowJobError(error);
    }
  };

  return new Map([
    [DOCUMENT_JOB_TYPES.scan, scan],
    [DOCUMENT_JOB_TYPES.extract, extract],
    [DOCUMENT_JOB_TYPES.cleanup, cleanup]
  ]);
}

let registered = false;

export function registerDocumentJobHandlers(): void {
  if (registered) return;
  for (const [jobType, handler] of createDocumentJobHandlers(getDocumentRuntime())) {
    registerJobHandler(jobType, handler);
  }
  registered = true;
}
