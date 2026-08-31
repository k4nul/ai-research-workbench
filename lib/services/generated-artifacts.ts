import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import {
  createObjectKey,
  sha256Hex,
  StorageError,
  type ObjectStorage,
  type StorageLocation,
  type StorageProviderKind
} from "@/lib/storage";
import { conflict } from "@/lib/services/errors";

export type GeneratedArtifactCategory = "debug" | "evaluations";

export type GeneratedArtifactReference = {
  objectId: string;
  provider: StorageProviderKind;
  bucket: string;
  key: string;
  contentType: string;
  filename: string;
  byteSize: number;
  sha256: string;
  replayed: boolean;
};

type ArtifactRow = {
  id: string;
  provider: StorageProviderKind;
  bucket: string;
  object_key: string;
  content_type: string;
  sanitized_filename: string | null;
  byte_size: string | null;
  sha256: string | null;
  upload_status: string;
  integrity_status: string;
  retention_status: string;
};

function artifactObjectId(
  category: GeneratedArtifactCategory,
  artifactId: string,
  filename: string
): string {
  return createHash("sha256")
    .update(`generated-artifact.v1\0${category}\0${artifactId}\0${filename}`)
    .digest("hex")
    .slice(0, 40);
}

function assertInput(input: {
  artifactId: string;
  filename: string;
  contentType: string;
  createdBy: string;
  bytes: Uint8Array;
}): void {
  if (!input.artifactId.trim() || input.artifactId.length > 512) {
    throw new Error("Generated artifact ID must contain 1-512 characters.");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.filename) ||
    input.filename.includes("..")
  ) {
    throw new Error("Generated artifact filename is invalid.");
  }
  if (!input.contentType.trim() || input.contentType.length > 200) {
    throw new Error("Generated artifact content type is invalid.");
  }
  if (!input.createdBy.trim() || input.createdBy.length > 512) {
    throw new Error("Generated artifact creator is invalid.");
  }
  if (input.bytes.byteLength === 0) {
    throw new Error("Generated artifact must not be empty.");
  }
}

function assertMatchingArtifact(
  row: ArtifactRow,
  expected: {
    provider: StorageProviderKind;
    location: StorageLocation;
    contentType: string;
    filename: string;
    byteSize: number;
    sha256: string;
  }
): void {
  if (
    row.provider !== expected.provider ||
    row.bucket !== expected.location.bucket ||
    row.object_key !== expected.location.key ||
    row.content_type !== expected.contentType ||
    row.sanitized_filename !== expected.filename ||
    Number(row.byte_size) !== expected.byteSize ||
    row.sha256 !== expected.sha256 ||
    row.upload_status !== "AVAILABLE" ||
    row.integrity_status !== "VERIFIED" ||
    row.retention_status !== "ACTIVE"
  ) {
    throw conflict(
      "GENERATED_ARTIFACT_CONFLICT",
      "The generated artifact identity was already used for different content."
    );
  }
}

async function selectArtifact(
  client: PoolClient,
  objectId: string
): Promise<ArtifactRow | undefined> {
  const result = await client.query<ArtifactRow>(
    `SELECT id, provider, bucket, object_key, content_type, sanitized_filename,
            byte_size::text, sha256, upload_status, integrity_status,
            retention_status
     FROM storage_objects WHERE id = $1 FOR UPDATE`,
    [objectId]
  );
  return result.rows[0];
}

export async function persistGeneratedArtifact(input: {
  storage: ObjectStorage;
  bucket: string;
  category: GeneratedArtifactCategory;
  artifactId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  createdBy: string;
  projectId?: string;
  sourceId?: string;
  maxBytes: number;
}): Promise<GeneratedArtifactReference> {
  assertInput(input);
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.bytes.byteLength > input.maxBytes
  ) {
    throw new StorageError(
      "OBJECT_TOO_LARGE",
      "Generated artifact exceeds the configured storage limit."
    );
  }
  const objectId = artifactObjectId(input.category, input.artifactId, input.filename);
  const location = {
    bucket: input.bucket,
    key: createObjectKey(input.category, objectId)
  };
  const byteSize = input.bytes.byteLength;
  const sha256 = sha256Hex(input.bytes);
  const expected = {
    provider: input.storage.provider,
    location,
    contentType: input.contentType,
    filename: input.filename,
    byteSize,
    sha256
  };
  const lockName = `generated-artifact:${objectId}`;
  const client = await getPool().connect();
  let replayed = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
    await client.query("BEGIN");
    const existing = await selectArtifact(client, objectId);
    if (existing) {
      assertMatchingArtifact(existing, expected);
      await input.storage.read(location, {
        maxBytes: input.maxBytes,
        expectedSha256: sha256
      });
      replayed = true;
    } else {
      try {
        await input.storage.put({
          location,
          bytes: input.bytes,
          contentType: input.contentType,
          expectedByteSize: byteSize,
          expectedSha256: sha256,
          metadata: {
            artifact: input.category,
            artifactid: objectId
          }
        });
      } catch (error) {
        if (!(error instanceof StorageError && error.code === "OBJECT_EXISTS")) {
          throw error;
        }
        await input.storage.read(location, {
          maxBytes: input.maxBytes,
          expectedSha256: sha256
        });
        replayed = true;
      }
      await client.query(
        `INSERT INTO storage_objects (
           id, provider, bucket, object_key, content_type, original_filename,
           sanitized_filename, byte_size, sha256, integrity_status,
           upload_status, retention_status, project_id, source_id, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $6, $7, $8, 'VERIFIED', 'AVAILABLE',
           'ACTIVE', $9, $10, $11
         )`,
        [
          objectId,
          input.storage.provider,
          input.bucket,
          location.key,
          input.contentType,
          input.filename,
          byteSize,
          sha256,
          input.projectId ?? null,
          input.sourceId ?? null,
          input.createdBy
        ]
      );
    }
    await client.query("COMMIT");
    return {
      objectId,
      provider: input.storage.provider,
      bucket: input.bucket,
      key: location.key,
      contentType: input.contentType,
      filename: input.filename,
      byteSize,
      sha256,
      replayed
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // The transaction outcome is ambiguous when COMMIT acknowledgement fails.
    // Keep the deterministic object so a retry can reconcile it with the catalog.
    throw error;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName])
      .catch(() => undefined);
    client.release();
  }
}

export async function discardGeneratedArtifact(input: {
  storage: ObjectStorage;
  reference: GeneratedArtifactReference;
  reason: string;
}): Promise<void> {
  if (input.storage.provider !== input.reference.provider) {
    throw new StorageError(
      "INVALID_LOCATION",
      "Generated artifact cleanup targeted a different storage provider."
    );
  }
  const reason = input.reason.replace(/[\0\r\n]+/g, " ").trim().slice(0, 500);
  const lockName = `generated-artifact:${input.reference.objectId}`;
  const client = await getPool().connect();
  let deletionReserved = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
    await client.query("BEGIN");
    const row = await selectArtifact(client, input.reference.objectId);
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    if (
      row.provider !== input.reference.provider ||
      row.bucket !== input.reference.bucket ||
      row.object_key !== input.reference.key ||
      row.sha256 !== input.reference.sha256
    ) {
      throw conflict(
        "GENERATED_ARTIFACT_CONFLICT",
        "Generated artifact cleanup metadata does not match the catalog."
      );
    }
    if (row.retention_status === "LEGAL_HOLD") {
      throw conflict(
        "GENERATED_ARTIFACT_LEGAL_HOLD",
        "The generated artifact is under legal hold."
      );
    }
    if (row.retention_status === "DELETED") {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `UPDATE storage_objects
       SET retention_status = 'PENDING_DELETE', cleanup_lease_owner = NULL,
           cleanup_lease_expires_at = NULL, last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [input.reference.objectId, reason || "Generated artifact compensation requested."]
    );
    await client.query("COMMIT");
    deletionReserved = true;
    try {
      await input.storage.delete({
        bucket: input.reference.bucket,
        key: input.reference.key
      });
      await client.query(
        `UPDATE storage_objects
         SET retention_status = 'DELETED', upload_status = 'DELETED',
             deleted_at = NOW(), last_error = NULL, updated_at = NOW()
         WHERE id = $1 AND retention_status = 'PENDING_DELETE'`,
        [input.reference.objectId]
      );
    } catch (error) {
      await client
        .query(
          `UPDATE storage_objects
           SET last_error = $2, updated_at = NOW()
           WHERE id = $1 AND retention_status = 'PENDING_DELETE'`,
          [
            input.reference.objectId,
            error instanceof Error
              ? error.message.replace(/[\0\r\n]+/g, " ").slice(0, 500)
              : "Generated artifact cleanup failed."
          ]
        )
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!deletionReserved) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName])
      .catch(() => undefined);
    client.release();
  }
}
