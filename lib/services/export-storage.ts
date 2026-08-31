import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db";
import {
  exportContentHash,
  loadExportContent
} from "@/lib/export/snapshot";
import {
  StorageError,
  createObjectKey,
  sha256Hex,
  type ObjectStorage,
  type StorageLocation,
  type StorageProviderKind
} from "@/lib/storage";
import { writeAuditEvent, type AuditActor } from "@/lib/services/audit";
import { AppError, conflict, notFound } from "@/lib/services/errors";
import { refreshProjectProgress } from "@/lib/services/progress";

export type PersistedExportFormat =
  | "MARKDOWN"
  | "HTML"
  | "PDF"
  | "DOCX"
  | "CSV"
  | "ZIP";

export interface PersistedExportSnapshot {
  projectUpdatedAt: string;
  contentHash: string;
  approvalStatus: string;
  qaPassedAt: string | null;
  approvedAt: string | null;
  deliverableId: string;
  deliverableUpdatedAt: string;
}

export interface ExportArtifactInput {
  format: PersistedExportFormat;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ExportStorageRuntime {
  storage: ObjectStorage;
  bucket: string;
  maxObjectBytes: number;
}

export interface ExportPersistenceExecution {
  jobId: string;
  workerId: string;
  attempt: number;
  signal: AbortSignal;
  requestedBy: AuditActor;
}

interface ExportRow {
  id: string;
  project_id: string;
  deliverable_id: string;
  format: PersistedExportFormat;
  storage_path: string;
  sha256: string;
  byte_size: string;
  storage_object_id: string;
  input_hash: string;
  persistence_status: "UPLOADING" | "AVAILABLE" | "FAILED";
  is_current: boolean;
  object_provider: StorageProviderKind;
  object_bucket: string;
  object_key: string;
  object_upload_status: "UPLOADING" | "AVAILABLE" | "FAILED" | "DELETED";
  object_retention_status: "ACTIVE" | "PENDING_DELETE" | "DELETED" | "LEGAL_HOLD";
  cleanup_lease_owner: string | null;
  cleanup_lease_current: boolean;
}

export interface ReusableExport {
  exportId: string;
  inputHash: string;
  sha256: string;
  byteSize: number;
  buffer: Buffer;
}

function stableSnapshotValue(
  projectId: string,
  format: PersistedExportFormat,
  snapshot: PersistedExportSnapshot
): string {
  return JSON.stringify({
    projectId,
    format,
    contentHash: snapshot.contentHash,
    approvalStatus: snapshot.approvalStatus,
    qaPassedAt: snapshot.qaPassedAt,
    approvedAt: snapshot.approvedAt,
    deliverableId: snapshot.deliverableId,
    deliverableUpdatedAt: snapshot.deliverableUpdatedAt
  });
}

export function exportInputHash(
  projectId: string,
  format: PersistedExportFormat,
  snapshot: PersistedExportSnapshot
): string {
  return createHash("sha256")
    .update(stableSnapshotValue(projectId, format, snapshot))
    .digest("hex");
}

function storagePath(provider: StorageProviderKind, location: Required<StorageLocation>): string {
  return `object://${provider.toLowerCase()}/${location.bucket}/${location.key}`;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown export storage failure.")
    .replace(/((?:bearer|password|secret|token|api[_-]?key))\s*[=:]\s*\S+/giu, "$1=[redacted]")
    .replace(/[\0\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
}

function throwIfExecutionAborted(execution?: ExportPersistenceExecution): void {
  if (!execution?.signal.aborted) return;
  throw execution.signal.reason instanceof Error
    ? execution.signal.reason
    : new AppError(409, "EXPORT_JOB_CANCELLED", "Export generation was cancelled.");
}

async function assertJobFence(
  client: PoolClient,
  projectId: string,
  execution: ExportPersistenceExecution
): Promise<void> {
  const result = await client.query<{
    status: string;
    lease_owner: string | null;
    attempts: number;
    lease_current: boolean;
  }>(
    `SELECT status, lease_owner, attempts,
      (lease_expires_at > NOW()) AS lease_current
     FROM jobs WHERE id = $1 AND project_id = $2 FOR UPDATE`,
    [execution.jobId, projectId]
  );
  const job = result.rows[0];
  if (job?.status === "CANCELLATION_REQUESTED") {
    throw new AppError(
      409,
      "EXPORT_JOB_CANCELLED",
      "Export generation was cancelled before its result was committed."
    );
  }
  if (
    !job ||
    job.status !== "RUNNING" ||
    job.lease_owner !== execution.workerId ||
    job.attempts !== execution.attempt ||
    !job.lease_current
  ) {
    throw conflict(
      "JOB_LEASE_LOST",
      "The export worker no longer owns the current job lease."
    );
  }
}

async function assertExecutionFence(
  projectId: string,
  execution?: ExportPersistenceExecution
): Promise<void> {
  if (!execution) return;
  throwIfExecutionAborted(execution);
  await withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rowCount) throw notFound("Project");
    await assertJobFence(client, projectId, execution);
  });
  throwIfExecutionAborted(execution);
}

async function validateSnapshot(
  client: PoolClient,
  projectId: string,
  snapshot: PersistedExportSnapshot,
  requireApproval: boolean
): Promise<boolean> {
  const project = await client.query<{
    approval_status: string;
    qa_passed_at: string | null;
    approved_at: string | null;
  }>(
    "SELECT approval_status, qa_passed_at::text, approved_at::text " +
      "FROM research_projects WHERE id = $1 FOR UPDATE",
    [projectId]
  );
  if (!project.rows[0]) throw notFound("Project");
  const deliverable = await client.query<{ id: string; updated_at: string }>(
    "SELECT id, updated_at::text FROM deliverables WHERE project_id = $1 " +
      "ORDER BY version DESC LIMIT 1",
    [projectId]
  );
  const current = project.rows[0];
  const currentDeliverable = deliverable.rows[0];
  const content = await loadExportContent(client, projectId);
  const unchanged =
    current.approval_status === snapshot.approvalStatus &&
    current.qa_passed_at === snapshot.qaPassedAt &&
    current.approved_at === snapshot.approvedAt &&
    currentDeliverable?.id === snapshot.deliverableId &&
    currentDeliverable.updated_at === snapshot.deliverableUpdatedAt &&
    content !== null &&
    exportContentHash(content) === snapshot.contentHash;
  if (!unchanged) return false;
  if (requireApproval) {
    if (current.approval_status !== "APPROVED") {
      throw conflict(
        "APPROVAL_REQUIRED",
        "Explicit human approval is required before final export."
      );
    }
    const blockers = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM qa_findings " +
        "WHERE project_id = $1 AND is_current = TRUE " +
        "AND severity = 'BLOCKER' AND resolution_status <> 'RESOLVED'",
      [projectId]
    );
    if (Number(blockers.rows[0].count) > 0) {
      throw conflict("QA_BLOCKED", "Resolve all QA blockers before final export.");
    }
  }
  return true;
}

async function exportRow(
  projectId: string,
  format: PersistedExportFormat,
  inputHash: string
): Promise<ExportRow | undefined> {
  const result = await withTransaction((client) =>
    client.query<ExportRow>(
      `SELECT pe.id, pe.project_id, pe.deliverable_id, pe.format, pe.storage_path,
        pe.sha256, pe.byte_size::text, pe.storage_object_id, pe.input_hash,
        pe.persistence_status, pe.is_current, so.provider AS object_provider,
        so.bucket AS object_bucket, so.object_key,
        so.upload_status AS object_upload_status,
        so.retention_status AS object_retention_status,
        so.cleanup_lease_owner,
        COALESCE(so.cleanup_lease_expires_at > NOW(), FALSE) AS cleanup_lease_current
       FROM project_exports pe
       JOIN storage_objects so ON so.id = pe.storage_object_id
       WHERE pe.project_id = $1 AND pe.format = $2 AND pe.input_hash = $3`,
      [projectId, format, inputHash]
    )
  );
  return result.rows[0];
}

function compatibleRuntime(row: ExportRow, runtime: ExportStorageRuntime): void {
  if (row.object_provider !== runtime.storage.provider || row.object_bucket !== runtime.bucket) {
    throw conflict(
      "EXPORT_STORAGE_PROVIDER_CHANGED",
      "The reusable export belongs to a different configured storage provider."
    );
  }
}

async function markMissing(row: ExportRow, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE project_exports SET persistence_status = 'FAILED', is_current = FALSE, " +
        "sanitized_error = $2 WHERE id = $1",
      [row.id, reason]
    );
    await client.query(
      "UPDATE storage_objects SET integrity_status = 'MISSING', upload_status = 'FAILED', " +
        "last_error = $2, updated_at = NOW() WHERE id = $1",
      [row.storage_object_id, reason]
    );
  });
}

async function readVerified(
  row: ExportRow,
  runtime: ExportStorageRuntime
): Promise<Buffer | null> {
  compatibleRuntime(row, runtime);
  const location = { bucket: row.object_bucket, key: row.object_key };
  try {
    const bytes = await runtime.storage.read(location, {
      maxBytes: runtime.maxObjectBytes,
      expectedSha256: row.sha256
    });
    if (bytes.byteLength !== Number(row.byte_size)) {
      await markMissing(row, "Stored export byte size differs from its catalog entry.");
      return null;
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (
      error instanceof StorageError &&
      (error.code === "OBJECT_NOT_FOUND" || error.code === "INTEGRITY_MISMATCH")
    ) {
      await markMissing(row, cleanError(error));
      return null;
    }
    throw error;
  }
}

export async function findReusableExport(input: {
  projectId: string;
  format: PersistedExportFormat;
  snapshot: PersistedExportSnapshot;
  runtime: ExportStorageRuntime;
  recoverIncomplete?: boolean;
  execution?: ExportPersistenceExecution;
}): Promise<ReusableExport | null> {
  await assertExecutionFence(input.projectId, input.execution);
  const inputHash = exportInputHash(input.projectId, input.format, input.snapshot);
  const row = await exportRow(input.projectId, input.format, inputHash);
  if (!row) return null;
  const complete =
    row.persistence_status === "AVAILABLE" &&
    row.object_upload_status === "AVAILABLE" &&
    row.object_retention_status === "ACTIVE" &&
    !row.cleanup_lease_current &&
    row.is_current;
  if (!input.recoverIncomplete && !complete) {
    return null;
  }
  if (
    input.recoverIncomplete &&
    row.object_retention_status !== "ACTIVE" &&
    row.object_retention_status !== "PENDING_DELETE"
  ) {
    return null;
  }
  const buffer = await readVerified(row, input.runtime);
  if (!buffer) return null;
  throwIfExecutionAborted(input.execution);
  if (!complete) {
    const finalized = await withTransaction(async (client) => {
      if (!(await validateSnapshot(client, input.projectId, input.snapshot, false))) return false;
      throwIfExecutionAborted(input.execution);
      if (input.execution) {
        await assertJobFence(client, input.projectId, input.execution);
      }
      throwIfExecutionAborted(input.execution);
      await client.query(
        "UPDATE project_exports SET is_current = FALSE " +
          "WHERE project_id = $1 AND format = $2 AND id <> $3 AND is_current = TRUE",
        [input.projectId, input.format, row.id]
      );
      const reactivated = await client.query(
        "UPDATE storage_objects SET upload_status = 'AVAILABLE', integrity_status = 'VERIFIED', " +
          "retention_status = 'ACTIVE', cleanup_lease_owner = NULL, " +
          "cleanup_lease_expires_at = NULL, last_error = NULL, updated_at = NOW() " +
          "WHERE id = $1 AND retention_status IN ('ACTIVE', 'PENDING_DELETE') " +
          "AND upload_status <> 'DELETED' " +
          "AND (cleanup_lease_owner IS NULL OR cleanup_lease_expires_at <= NOW()) " +
          "RETURNING id",
        [row.storage_object_id]
      );
      if (!reactivated.rowCount) {
        throw conflict(
          "EXPORT_CLEANUP_BUSY",
          "The prior export object is currently being cleaned up. Retry after cleanup finishes."
        );
      }
      await client.query(
        "UPDATE project_exports SET persistence_status = 'AVAILABLE', is_current = TRUE, sanitized_error = NULL " +
          "WHERE id = $1",
        [row.id]
      );
      await writeAuditEvent(client, {
        projectId: input.projectId,
        actorType: "SYSTEM",
        actorLabel: input.execution ? "Export worker" : "Export service",
        action: "EXPORT_GENERATED",
        resourceType: "project_export",
        resourceId: row.id,
        afterState: {
          format: input.format,
          sha256: row.sha256,
          byteSize: Number(row.byte_size),
          inputHash,
          storageProvider: input.runtime.storage.provider,
          recovered: true,
          ...(input.execution
            ? {
                jobId: input.execution.jobId,
                workerId: input.execution.workerId,
                attempt: input.execution.attempt,
                requestedBy: input.execution.requestedBy
              }
            : {})
        }
      });
      await refreshProjectProgress(client, input.projectId);
      return true;
    });
    if (!finalized) return null;
  }
  return {
    exportId: row.id,
    inputHash,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    buffer
  };
}

async function reserveExport(input: {
  projectId: string;
  snapshot: PersistedExportSnapshot;
  artifact: ExportArtifactInput;
  runtime: ExportStorageRuntime;
  inputHash: string;
  sha256: string;
  requireApproval: boolean;
  execution?: ExportPersistenceExecution;
}): Promise<{ row: ExportRow; alreadyAvailable: boolean }> {
  return withTransaction(async (client) => {
    if (!(await validateSnapshot(client, input.projectId, input.snapshot, input.requireApproval))) {
      throw conflict(
        "EXPORT_STALE",
        "The project changed while the artifact was generated. Generate it again."
      );
    }
    throwIfExecutionAborted(input.execution);
    if (input.execution) {
      await assertJobFence(client, input.projectId, input.execution);
    }
    throwIfExecutionAborted(input.execution);
    const existing = await client.query<ExportRow>(
      `SELECT pe.id, pe.project_id, pe.deliverable_id, pe.format, pe.storage_path,
        pe.sha256, pe.byte_size::text, pe.storage_object_id, pe.input_hash,
        pe.persistence_status, pe.is_current, so.provider AS object_provider,
        so.bucket AS object_bucket, so.object_key,
        so.upload_status AS object_upload_status,
        so.retention_status AS object_retention_status,
        so.cleanup_lease_owner,
        COALESCE(so.cleanup_lease_expires_at > NOW(), FALSE) AS cleanup_lease_current
       FROM project_exports pe JOIN storage_objects so ON so.id = pe.storage_object_id
       WHERE pe.project_id = $1 AND pe.format = $2 AND pe.input_hash = $3
       FOR UPDATE OF pe, so`,
      [input.projectId, input.artifact.format, input.inputHash]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      compatibleRuntime(row, input.runtime);
      if (row.cleanup_lease_current) {
        throw conflict(
          "EXPORT_CLEANUP_BUSY",
          "The prior export object is currently being cleaned up. Retry after cleanup finishes."
        );
      }
      if (
        row.persistence_status === "AVAILABLE" &&
        row.object_upload_status === "AVAILABLE" &&
        row.object_retention_status === "ACTIVE" &&
        row.is_current
      ) {
        return { row, alreadyAvailable: true };
      }
      await client.query(
        `UPDATE storage_objects SET content_type = $2, original_filename = $3,
          sanitized_filename = $3, byte_size = $4, sha256 = $5,
          integrity_status = 'PENDING_VERIFICATION', upload_status = 'UPLOADING',
          retention_status = 'ACTIVE', deleted_at = NULL, cleanup_lease_owner = NULL,
          cleanup_lease_expires_at = NULL, last_error = NULL,
          updated_at = NOW() WHERE id = $1`,
        [
          row.storage_object_id,
          input.artifact.mimeType,
          input.artifact.filename,
          input.artifact.buffer.byteLength,
          input.sha256
        ]
      );
      const updated = await client.query<ExportRow>(
        `UPDATE project_exports SET sha256 = $2, byte_size = $3,
          persistence_status = 'UPLOADING', sanitized_error = NULL,
          duration_ms = NULL, is_current = FALSE
         WHERE id = $1
         RETURNING id, project_id, deliverable_id, format, storage_path, sha256,
           byte_size::text, storage_object_id, input_hash, persistence_status, is_current,
           $4::text AS object_provider, $5::text AS object_bucket,
           $6::text AS object_key, 'UPLOADING'::text AS object_upload_status,
           'ACTIVE'::text AS object_retention_status, NULL::text AS cleanup_lease_owner,
           FALSE AS cleanup_lease_current`,
        [
          row.id,
          input.sha256,
          input.artifact.buffer.byteLength,
          input.runtime.storage.provider,
          input.runtime.bucket,
          row.object_key
        ]
      );
      return { row: updated.rows[0], alreadyAvailable: false };
    }

    const exportId = randomUUID();
    const objectId = randomUUID();
    const key = createObjectKey("exports", input.inputHash);
    const location = { bucket: input.runtime.bucket, key };
    await client.query(
      `INSERT INTO storage_objects (
         id, provider, bucket, object_key, content_type, original_filename,
         sanitized_filename, byte_size, sha256, integrity_status, upload_status,
         retention_status, project_id, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8,
         'PENDING_VERIFICATION', 'UPLOADING', 'ACTIVE', $9, 'Export service')`,
      [
        objectId,
        input.runtime.storage.provider,
        input.runtime.bucket,
        key,
        input.artifact.mimeType,
        input.artifact.filename,
        input.artifact.buffer.byteLength,
        input.sha256,
        input.projectId
      ]
    );
    const inserted = await client.query<ExportRow>(
      `INSERT INTO project_exports (
         id, project_id, deliverable_id, format, storage_path, sha256, byte_size,
         is_current, storage_object_id, input_hash, persistence_status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, 'UPLOADING')
       RETURNING id, project_id, deliverable_id, format, storage_path, sha256,
         byte_size::text, storage_object_id, input_hash, persistence_status, is_current,
         $10::text AS object_provider, $11::text AS object_bucket,
         $12::text AS object_key, 'UPLOADING'::text AS object_upload_status,
         'ACTIVE'::text AS object_retention_status, NULL::text AS cleanup_lease_owner,
         FALSE AS cleanup_lease_current`,
      [
        exportId,
        input.projectId,
        input.snapshot.deliverableId,
        input.artifact.format,
        storagePath(input.runtime.storage.provider, location),
        input.sha256,
        input.artifact.buffer.byteLength,
        objectId,
        input.inputHash,
        input.runtime.storage.provider,
        input.runtime.bucket,
        key
      ]
    );
    return { row: inserted.rows[0], alreadyAvailable: false };
  });
}

async function markPersistenceFailure(row: ExportRow, error: unknown): Promise<void> {
  const message = cleanError(error);
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE project_exports SET persistence_status = 'FAILED', is_current = FALSE, " +
        "sanitized_error = $2 WHERE id = $1",
      [row.id, message]
    );
    await client.query(
      "UPDATE storage_objects SET upload_status = 'FAILED', retention_status = 'PENDING_DELETE', " +
        "last_error = $2, updated_at = NOW() WHERE id = $1" +
        " AND retention_status IN ('ACTIVE', 'PENDING_DELETE')",
      [row.storage_object_id, message]
    );
  });
}

async function acquireExportLock(
  key: string,
  execution?: ExportPersistenceExecution
): Promise<PoolClient> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    throwIfExecutionAborted(execution);
    const client = await getPool().connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [key]
      );
      if (result.rows[0].acquired) return client;
    } catch (error) {
      client.release();
      throw error;
    }
    client.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw conflict("EXPORT_BUSY", "Another export for this snapshot is still being persisted.");
}

async function releaseExportLock(client: PoolClient, key: string): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
  } finally {
    client.release();
  }
}

export async function persistExportArtifact(input: {
  projectId: string;
  snapshot: PersistedExportSnapshot;
  artifact: ExportArtifactInput;
  requireApproval: boolean;
  runtime: ExportStorageRuntime;
  durationMs: number;
  execution?: ExportPersistenceExecution;
}): Promise<ReusableExport> {
  await assertExecutionFence(input.projectId, input.execution);
  const inputHash = exportInputHash(input.projectId, input.artifact.format, input.snapshot);
  const sha256 = sha256Hex(input.artifact.buffer);
  const lockKey = `${input.projectId}:${input.artifact.format}:${inputHash}`;
  const lockClient = await acquireExportLock(lockKey, input.execution);
  try {
    throwIfExecutionAborted(input.execution);
    const reusable = await findReusableExport({
      projectId: input.projectId,
      format: input.artifact.format,
      snapshot: input.snapshot,
      runtime: input.runtime,
      recoverIncomplete: true,
      execution: input.execution
    });
    if (reusable) return reusable;

    const reserved = await reserveExport({ ...input, inputHash, sha256 });
    if (reserved.alreadyAvailable) {
      const buffer = await readVerified(reserved.row, input.runtime);
      if (!buffer) {
        throw conflict(
          "EXPORT_RETRY_REQUIRED",
          "The stored export failed integrity verification. Generate it again."
        );
      }
      throwIfExecutionAborted(input.execution);
      return {
        exportId: reserved.row.id,
        inputHash,
        sha256: reserved.row.sha256,
        byteSize: Number(reserved.row.byte_size),
        buffer
      };
    }

    const location = {
      bucket: reserved.row.object_bucket,
      key: reserved.row.object_key
    };
    try {
      throwIfExecutionAborted(input.execution);
      try {
        await input.runtime.storage.put({
          location,
          bytes: input.artifact.buffer,
          contentType: input.artifact.mimeType,
          expectedByteSize: input.artifact.buffer.byteLength,
          expectedSha256: sha256,
          metadata: { inputHash, exportId: reserved.row.id }
        });
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "OBJECT_EXISTS") throw error;
        await input.runtime.storage.read(location, {
          maxBytes: input.runtime.maxObjectBytes,
          expectedSha256: sha256
        });
      }
      throwIfExecutionAborted(input.execution);

      const finalized = await withTransaction(async (client) => {
        if (
          !(await validateSnapshot(
            client,
            input.projectId,
            input.snapshot,
            input.requireApproval
          ))
        ) {
          await client.query(
            "UPDATE project_exports SET persistence_status = 'FAILED', is_current = FALSE, " +
              "sanitized_error = 'Export input became stale before persistence completed.' WHERE id = $1",
            [reserved.row.id]
          );
          await client.query(
            "UPDATE storage_objects SET retention_status = 'PENDING_DELETE', " +
              "last_error = 'Export input became stale before persistence completed.', " +
              "updated_at = NOW() WHERE id = $1" +
              " AND retention_status IN ('ACTIVE', 'PENDING_DELETE')",
            [reserved.row.storage_object_id]
          );
          return false;
        }
        throwIfExecutionAborted(input.execution);
        if (input.execution) {
          await assertJobFence(client, input.projectId, input.execution);
        }
        throwIfExecutionAborted(input.execution);
        await client.query(
          "UPDATE project_exports SET is_current = FALSE " +
            "WHERE project_id = $1 AND format = $2 AND id <> $3 AND is_current = TRUE",
          [input.projectId, input.artifact.format, reserved.row.id]
        );
        await client.query(
          "UPDATE storage_objects SET upload_status = 'AVAILABLE', integrity_status = 'VERIFIED', " +
            "retention_status = 'ACTIVE', last_error = NULL, updated_at = NOW() WHERE id = $1",
          [reserved.row.storage_object_id]
        );
        await client.query(
          `UPDATE project_exports SET persistence_status = 'AVAILABLE', is_current = TRUE,
            sanitized_error = NULL, duration_ms = $2 WHERE id = $1`,
          [reserved.row.id, Math.max(0, Math.round(input.durationMs))]
        );
        await writeAuditEvent(client, {
          projectId: input.projectId,
          actorType: "SYSTEM",
          actorLabel: input.execution ? "Export worker" : "Export service",
          action: "EXPORT_GENERATED",
          resourceType: "project_export",
          resourceId: reserved.row.id,
          afterState: {
            format: input.artifact.format,
            filename: input.artifact.filename,
            sha256,
            byteSize: input.artifact.buffer.byteLength,
            inputHash,
            storageProvider: input.runtime.storage.provider,
            ...(input.execution
              ? {
                  jobId: input.execution.jobId,
                  workerId: input.execution.workerId,
                  attempt: input.execution.attempt,
                  requestedBy: input.execution.requestedBy
                }
              : {})
          }
        });
        await refreshProjectProgress(client, input.projectId);
        return true;
      });
      if (!finalized) {
        throw conflict(
          "EXPORT_STALE",
          "The project changed while the artifact was generated. Generate it again."
        );
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EXPORT_STALE")) {
        await markPersistenceFailure(reserved.row, error);
      }
      throw error;
    }
    return {
      exportId: reserved.row.id,
      inputHash,
      sha256,
      byteSize: input.artifact.buffer.byteLength,
      buffer: input.artifact.buffer
    };
  } finally {
    await releaseExportLock(lockClient, lockKey);
  }
}
