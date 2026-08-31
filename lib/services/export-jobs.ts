import { z } from "zod";

import { getConfig } from "@/lib/config";
import { withTransaction } from "@/lib/db";
import type { JobErrorClass } from "@/lib/domain/jobs";
import {
  loadExportDataInTransaction,
  type ExportFormat
} from "@/lib/export/generate";
import { writeAuditEvent, type AuditActor } from "@/lib/services/audit";
import { conflict, notFound } from "@/lib/services/errors";
import {
  submitJobInTransaction,
  type JobRow
} from "@/lib/services/jobs";

export const EXPORT_JOB_TYPE = "GENERATE_EXPORT";

export const exportFormatSchema = z.enum([
  "MARKDOWN",
  "HTML",
  "PDF",
  "DOCX",
  "CSV",
  "ZIP"
]);

const projectIdSchema = z.string().trim().min(1).max(500);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Use letters, numbers, dots, underscores, colons, or hyphens."
  );
const auditActorSchema = z
  .object({
    actorType: z.enum(["USER", "AI", "SYSTEM"]),
    actorLabel: z.string().trim().min(1).max(500)
  })
  .strict();
const exportSnapshotSchema = z
  .object({
    projectUpdatedAt: z.string().min(1).max(100),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvalStatus: z.string().min(1).max(100),
    qaPassedAt: z.string().min(1).max(100).nullable(),
    approvedAt: z.string().min(1).max(100).nullable(),
    deliverableId: z.string().min(1).max(500),
    deliverableUpdatedAt: z.string().min(1).max(100)
  })
  .strict();
const exportJobPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    format: exportFormatSchema,
    requireApproval: z.boolean(),
    snapshot: exportSnapshotSchema,
    requestedBy: auditActorSchema
  })
  .strict();

export type ExportJobPayload = z.infer<typeof exportJobPayloadSchema>;

export class ExportJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errorClass: JobErrorClass
  ) {
    super(message);
    this.name = "ExportJobError";
  }
}

export type ExportJobSubmission = {
  job: {
    id: string;
    jobType: string;
    projectId: string;
    format: ExportFormat;
    status: JobRow["status"];
  };
  created: boolean;
  queued: boolean;
};

function publicSubmission(
  job: JobRow,
  projectId: string,
  format: ExportFormat,
  created: boolean
): ExportJobSubmission {
  return {
    job: {
      id: job.id,
      jobType: job.job_type,
      projectId,
      format,
      status: job.status
    },
    created,
    queued: ["QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT"].includes(job.status)
  };
}

function assertMatchingExistingJob(
  job: JobRow,
  projectId: string,
  format: ExportFormat
): ExportJobPayload {
  let payload: ExportJobPayload;
  try {
    payload = exportJobPayloadSchema.parse(job.input_reference);
  } catch {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key is already associated with different export work."
    );
  }
  if (
    job.job_type !== EXPORT_JOB_TYPE ||
    job.project_id !== projectId ||
    payload.projectId !== projectId ||
    payload.format !== format
  ) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key is already associated with different export work."
    );
  }
  return payload;
}

export async function submitProjectExportJob(input: {
  projectId: string;
  format: ExportFormat;
  idempotencyKey: string;
  actor: AuditActor;
}): Promise<ExportJobSubmission> {
  const projectId = projectIdSchema.parse(input.projectId);
  const format = exportFormatSchema.parse(input.format);
  const requestKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const actor = auditActorSchema.parse(input.actor);
  const requireApproval = format === "ZIP";
  const jobKey = `export:${format.toLowerCase()}:${requestKey}`;

  return withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rowCount) throw notFound("Project");

    const existing = await client.query<JobRow>(
      "SELECT * FROM jobs WHERE project_id = $1 AND idempotency_key = $2",
      [projectId, jobKey]
    );
    if (existing.rows[0]) {
      assertMatchingExistingJob(existing.rows[0], projectId, format);
      return publicSubmission(existing.rows[0], projectId, format, false);
    }

    const data = await loadExportDataInTransaction(
      client,
      projectId,
      requireApproval
    );
    const payload: ExportJobPayload = {
      projectId,
      format,
      requireApproval,
      snapshot: data.snapshot,
      requestedBy: actor
    };
    const config = getConfig();
    const submitted = await submitJobInTransaction(client, {
      projectId,
      jobType: EXPORT_JOB_TYPE,
      inputReference: payload,
      idempotencyKey: jobKey,
      priority: 10,
      maxAttempts: config.jobMaxAttempts,
      timeoutMs: config.jobDefaultTimeoutMs
    });
    if (submitted.created) {
      await writeAuditEvent(client, {
        projectId,
        ...actor,
        action: "EXPORT_QUEUED",
        resourceType: "job",
        resourceId: submitted.job.id,
        afterState: {
          format,
          requireApproval,
          contentHash: data.snapshot.contentHash,
          deliverableId: data.snapshot.deliverableId
        }
      });
    }
    return publicSubmission(submitted.job, projectId, format, submitted.created);
  });
}

export function parseExportJob(job: JobRow): ExportJobPayload {
  if (job.job_type !== EXPORT_JOB_TYPE) {
    throw new ExportJobError(
      "INVALID_EXPORT_JOB",
      "The job is not an export job.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  const payload = exportJobPayloadSchema.parse(job.input_reference);
  if (job.project_id !== payload.projectId) {
    throw new ExportJobError(
      "EXPORT_JOB_LINK_MISMATCH",
      "The export payload does not match its durable job linkage.",
      "NON_RETRYABLE_SECURITY"
    );
  }
  return payload;
}
