import type { PoolClient } from "pg";
import type { DocumentStatus } from "@/lib/documents";
import { withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/services/audit";
import {
  assertDocumentJobFence,
  type DocumentActor,
  type DocumentJobFence
} from "@/lib/services/documents";
import { conflict, notFound } from "@/lib/services/errors";
import {
  submitJobInTransaction,
  type JobRow
} from "@/lib/services/jobs";

export const DOCUMENT_JOB_TYPES = {
  scan: "DOCUMENT_SCAN",
  extract: "DOCUMENT_EXTRACT",
  cleanup: "STORAGE_CLEANUP"
} as const;

export type DocumentJobSubmission = {
  jobId: string;
  jobType: (typeof DOCUMENT_JOB_TYPES)["scan" | "extract"];
  status: JobRow["status"];
  created: boolean;
};

type LockedDocumentJobState = {
  status: DocumentStatus;
  current_extraction_id: string | null;
  sha256: string | null;
};

const ACTIVE_JOB_STATUSES = [
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "RETRY_WAIT",
  "CANCELLATION_REQUESTED"
] as const;

function assertActor(actor: DocumentActor): void {
  if (!actor.actorId.trim() || !actor.label.trim()) {
    throw new Error("A document job actor is required.");
  }
}

function requestKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error("Document job idempotency keys must use 1-200 safe characters.");
  }
  return normalized;
}

function jobSubmission(job: JobRow, created: boolean): DocumentJobSubmission {
  if (job.job_type !== DOCUMENT_JOB_TYPES.scan && job.job_type !== DOCUMENT_JOB_TYPES.extract) {
    throw new Error("Unexpected document job type.");
  }
  return { jobId: job.id, jobType: job.job_type, status: job.status, created };
}

function inputRecord(job: JobRow): Record<string, unknown> {
  return job.input_reference && typeof job.input_reference === "object"
    ? (job.input_reference as Record<string, unknown>)
    : {};
}

async function lockProject(client: PoolClient, projectId: string): Promise<void> {
  const result = await client.query(
    "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
    [projectId]
  );
  if (!result.rowCount) throw notFound("Project");
}

async function lockDocumentState(
  client: PoolClient,
  projectId: string,
  documentId: string
): Promise<LockedDocumentJobState> {
  const result = await client.query<LockedDocumentJobState>(
    "SELECT d.status, d.current_extraction_id, o.sha256" +
      " FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id" +
      " WHERE d.project_id = $1 AND d.id = $2 FOR UPDATE OF d, o",
    [projectId, documentId]
  );
  if (!result.rows[0]) throw notFound("Document");
  return result.rows[0];
}

async function existingIdempotentJob(
  client: PoolClient,
  projectId: string,
  idempotencyKey: string,
  jobType: string,
  documentId: string,
  autoExtract?: boolean
): Promise<JobRow | undefined> {
  const result = await client.query<JobRow>(
    "SELECT * FROM jobs WHERE project_id = $1 AND idempotency_key = $2",
    [projectId, idempotencyKey]
  );
  const job = result.rows[0];
  if (!job) return undefined;
  const input = inputRecord(job);
  if (
    job.job_type !== jobType ||
    input.documentId !== documentId ||
    (autoExtract !== undefined && input.autoExtract !== autoExtract)
  ) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key is already associated with different document work."
    );
  }
  return job;
}

async function assertNoActiveDocumentJob(
  client: PoolClient,
  projectId: string,
  documentId: string,
  jobType: string
): Promise<void> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM jobs WHERE project_id = $1 AND job_type = $2" +
      " AND input_reference ->> 'documentId' = $3 AND status = ANY($4::text[])" +
      " ORDER BY created_at LIMIT 1",
    [projectId, jobType, documentId, ACTIVE_JOB_STATUSES]
  );
  if (result.rows[0]) {
    throw conflict(
      "DOCUMENT_JOB_ACTIVE",
      "A document job of this type is already active.",
      { jobId: result.rows[0].id }
    );
  }
}

export async function enqueueDocumentScan(input: {
  projectId: string;
  documentId: string;
  idempotencyKey: string;
  autoExtract?: boolean;
  actor: DocumentActor;
  parentJobId?: string;
  correlationId?: string;
}): Promise<DocumentJobSubmission> {
  assertActor(input.actor);
  const autoExtract = input.autoExtract ?? true;
  const key = `document:${input.documentId}:scan:${requestKey(input.idempotencyKey)}`;
  return withTransaction(async (client) => {
    await lockProject(client, input.projectId);
    const existing = await existingIdempotentJob(
      client,
      input.projectId,
      key,
      DOCUMENT_JOB_TYPES.scan,
      input.documentId,
      autoExtract
    );
    if (existing) return jobSubmission(existing, false);
    await assertNoActiveDocumentJob(
      client,
      input.projectId,
      input.documentId,
      DOCUMENT_JOB_TYPES.scan
    );
    const document = await lockDocumentState(client, input.projectId, input.documentId);
    if (!(["QUARANTINED", "BLOCKED_SCANNER_UNAVAILABLE", "SCANNING"] as DocumentStatus[]).includes(document.status)) {
      throw conflict("DOCUMENT_NOT_SCANNABLE", "Document is not waiting for a malware scan.");
    }
    if (!document.sha256) {
      throw conflict("DOCUMENT_INTEGRITY_PENDING", "Document integrity metadata is unavailable.");
    }
    const submitted = await submitJobInTransaction(client, {
      projectId: input.projectId,
      jobType: DOCUMENT_JOB_TYPES.scan,
      inputReference: {
        documentId: input.documentId,
        expectedObjectSha256: document.sha256,
        autoExtract
      },
      idempotencyKey: key,
      parentJobId: input.parentJobId,
      correlationId: input.correlationId,
      priority: 20
    });
    await writeAuditEvent(client, {
      projectId: input.projectId,
      actorType: input.actor.actorType,
      actorLabel: input.actor.label,
      action: "DOCUMENT_SCAN_REQUESTED",
      resourceType: "document",
      resourceId: input.documentId,
      afterState: { jobId: submitted.job.id, autoExtract }
    });
    return jobSubmission(submitted.job, submitted.created);
  });
}

export async function enqueueDocumentExtraction(input: {
  projectId: string;
  documentId: string;
  idempotencyKey: string;
  actor: DocumentActor;
  parentJobId?: string;
  correlationId?: string;
  parentJobFence?: DocumentJobFence;
}): Promise<DocumentJobSubmission> {
  assertActor(input.actor);
  const key = `document:${input.documentId}:extract:${requestKey(input.idempotencyKey)}`;
  return withTransaction(async (client) => {
    await lockProject(client, input.projectId);
    await assertDocumentJobFence(
      client,
      input.projectId,
      input.documentId,
      DOCUMENT_JOB_TYPES.scan,
      input.parentJobFence
    );
    const existing = await existingIdempotentJob(
      client,
      input.projectId,
      key,
      DOCUMENT_JOB_TYPES.extract,
      input.documentId
    );
    if (existing) return jobSubmission(existing, false);
    await assertNoActiveDocumentJob(
      client,
      input.projectId,
      input.documentId,
      DOCUMENT_JOB_TYPES.extract
    );
    const document = await lockDocumentState(client, input.projectId, input.documentId);
    if (
      !(["CLEAN", "READY", "EXTRACTION_FAILED", "OCR_REQUIRED_UNSUPPORTED", "EXTRACTING"] as DocumentStatus[]).includes(
        document.status
      )
    ) {
      throw conflict("DOCUMENT_NOT_EXTRACTABLE", "Document is not ready for extraction.");
    }
    if (!document.sha256) {
      throw conflict("DOCUMENT_INTEGRITY_PENDING", "Document integrity metadata is unavailable.");
    }
    const submitted = await submitJobInTransaction(client, {
      projectId: input.projectId,
      jobType: DOCUMENT_JOB_TYPES.extract,
      inputReference: {
        documentId: input.documentId,
        expectedObjectSha256: document.sha256,
        expectedExtractionId: document.current_extraction_id
      },
      idempotencyKey: key,
      parentJobId: input.parentJobId,
      correlationId: input.correlationId,
      priority: 10
    });
    await writeAuditEvent(client, {
      projectId: input.projectId,
      actorType: input.actor.actorType,
      actorLabel: input.actor.label,
      action: "DOCUMENT_EXTRACTION_REQUESTED",
      resourceType: "document",
      resourceId: input.documentId,
      afterState: {
        jobId: submitted.job.id,
        previousExtractionId: document.current_extraction_id
      }
    });
    await assertDocumentJobFence(
      client,
      input.projectId,
      input.documentId,
      DOCUMENT_JOB_TYPES.scan,
      input.parentJobFence
    );
    return jobSubmission(submitted.job, submitted.created);
  });
}
