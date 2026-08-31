import { randomUUID } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { getPool, query } from "@/lib/db";
import {
  StorageError,
  type ListedObject,
  type ObjectStorage,
  type StorageLocation,
  type StorageProviderKind
} from "@/lib/storage/types";

const LEGACY_STORAGE_CATEGORIES = ["uploads", "exports"] as const;
const UNTRACKED_REPORT_SAMPLE_LIMIT = 100;

function normalizeObjectIds(objectIds: readonly string[] | undefined): readonly string[] | null {
  if (objectIds === undefined) return null;
  const normalized = [...new Set(objectIds)];
  if (
    normalized.some(
      (objectId) => !objectId.trim() || objectId.length > 500 || /[\0\r\n]/.test(objectId)
    )
  ) {
    throw new Error("Storage cleanup object IDs are invalid.");
  }
  return normalized;
}

function throwIfCleanupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Storage cleanup was aborted.");
}

async function deleteLegacyStorageFile(storageRoot: string, legacyStoragePath: string): Promise<void> {
  const root = path.resolve(storageRoot);
  if (root === path.parse(root).root) {
    throw new StorageError("INVALID_LOCATION", "Filesystem root cannot be a legacy storage root.");
  }
  const target = path.resolve(legacyStoragePath);
  const categoryRoot = LEGACY_STORAGE_CATEGORIES.map((category) =>
    path.resolve(root, category)
  ).find((candidate) => target.startsWith(candidate + path.sep));
  if (!categoryRoot) {
    throw new StorageError(
      "INVALID_LOCATION",
      "Legacy storage path escaped the configured storage categories."
    );
  }
  let fileStat;
  try {
    fileStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new StorageError(
      "INVALID_OBJECT",
      "Refusing to delete a non-regular legacy storage object."
    );
  }
  const [resolvedRoot, resolvedCategoryRoot, resolvedParent] = await Promise.all([
    realpath(root),
    realpath(categoryRoot),
    realpath(path.dirname(target))
  ]);
  if (
    !resolvedCategoryRoot.startsWith(resolvedRoot + path.sep) ||
    (resolvedParent !== resolvedCategoryRoot &&
      !resolvedParent.startsWith(resolvedCategoryRoot + path.sep))
  ) {
    throw new StorageError(
      "INVALID_LOCATION",
      "Legacy storage path resolved outside the configured storage root."
    );
  }
  await unlink(target);
}

export interface CleanupCandidate {
  id: string;
  provider: StorageProviderKind;
  location: StorageLocation;
  legacyStoragePath?: string;
}

export interface StorageObjectCatalog {
  claimDeletionCandidates(input: {
    provider: StorageProviderKind;
    owner: string;
    leaseSeconds: number;
    limit: number;
    objectIds?: readonly string[];
  }): Promise<readonly CleanupCandidate[]>;
  countPendingDeletions(input: {
    provider: StorageProviderKind;
    objectIds?: readonly string[];
  }): Promise<number>;
  deleteClaimed(
    id: string,
    owner: string,
    operation: () => Promise<void>
  ): Promise<boolean>;
  markDeleteFailed(id: string, owner: string, sanitizedError: string): Promise<void>;
  trackedKeys(input: {
    provider: StorageProviderKind;
    bucket: string;
    keys: readonly string[];
  }): Promise<ReadonlySet<string>>;
}

function sanitizeCleanupError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown storage cleanup failure.";
  return error.message.replace(/[\0\r\n]+/g, " ").trim().slice(0, 500);
}

export class PostgresStorageObjectCatalog implements StorageObjectCatalog {
  async claimDeletionCandidates(input: {
    provider: StorageProviderKind;
    owner: string;
    leaseSeconds: number;
    limit: number;
    objectIds?: readonly string[];
  }): Promise<readonly CleanupCandidate[]> {
    const objectIds = normalizeObjectIds(input.objectIds);
    if (
      !input.owner.trim() ||
      !Number.isSafeInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new Error("Storage cleanup claim options are invalid.");
    }
    const result = await query<{
      id: string;
      provider: StorageProviderKind;
      bucket: string;
      object_key: string;
      legacy_storage_path: string | null;
    }>(
      "WITH candidates AS (" +
        " SELECT id FROM storage_objects" +
        " WHERE retention_status = 'PENDING_DELETE'" +
        " AND (($5::text[] IS NOT NULL AND id = ANY($5::text[]))" +
        " OR ($5::text[] IS NULL AND (provider = $1 OR legacy_storage_path IS NOT NULL)))" +
        " AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= NOW())" +
        " ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT $2" +
        ") UPDATE storage_objects o" +
        " SET cleanup_lease_owner = $3," +
        " cleanup_lease_expires_at = NOW() + ($4::text || ' seconds')::interval," +
        " delete_attempts = delete_attempts + 1, updated_at = NOW()" +
        " FROM candidates c WHERE o.id = c.id" +
        " RETURNING o.id, o.provider, o.bucket, o.object_key, o.legacy_storage_path",
      [input.provider, input.limit, input.owner, input.leaseSeconds, objectIds]
    );
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      location: { bucket: row.bucket, key: row.object_key },
      legacyStoragePath: row.legacy_storage_path ?? undefined
    }));
  }

  async countPendingDeletions(input: {
    provider: StorageProviderKind;
    objectIds?: readonly string[];
  }): Promise<number> {
    const objectIds = normalizeObjectIds(input.objectIds);
    const result = await query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM storage_objects" +
        " WHERE retention_status = 'PENDING_DELETE'" +
        " AND (($2::text[] IS NOT NULL AND id = ANY($2::text[]))" +
        " OR ($2::text[] IS NULL AND (provider = $1 OR legacy_storage_path IS NOT NULL)))",
      [input.provider, objectIds]
    );
    return result.rows[0]?.count ?? 0;
  }

  async deleteClaimed(
    id: string,
    owner: string,
    operation: () => Promise<void>
  ): Promise<boolean> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        "SELECT id FROM storage_objects" +
          " WHERE id = $1 AND cleanup_lease_owner = $2" +
          " AND retention_status = 'PENDING_DELETE'" +
          " AND cleanup_lease_expires_at > clock_timestamp() FOR UPDATE",
        [id, owner]
      );
      if (claimed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await operation();
      const deleted = await client.query(
        "UPDATE storage_objects SET retention_status = 'DELETED', upload_status = 'DELETED'," +
          " deleted_at = NOW(), cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL," +
          " last_error = NULL, updated_at = NOW()" +
          " WHERE id = $1 AND cleanup_lease_owner = $2 AND retention_status = 'PENDING_DELETE'",
        [id, owner]
      );
      if (deleted.rowCount !== 1) {
        throw new Error("Storage cleanup lease was lost before completion.");
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeleteFailed(id: string, owner: string, sanitizedError: string): Promise<void> {
    await query(
      "UPDATE storage_objects SET cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL," +
        " last_error = $3, updated_at = NOW()" +
        " WHERE id = $1 AND cleanup_lease_owner = $2 AND retention_status = 'PENDING_DELETE'",
      [id, owner, sanitizedError.slice(0, 500)]
    );
  }

  async trackedKeys(input: {
    provider: StorageProviderKind;
    bucket: string;
    keys: readonly string[];
  }): Promise<ReadonlySet<string>> {
    if (input.keys.length === 0) return new Set();
    const result = await query<{ object_key: string }>(
      "SELECT object_key FROM storage_objects" +
        " WHERE provider = $1 AND bucket = $2 AND object_key = ANY($3::text[])" +
        " AND retention_status <> 'DELETED'",
      [input.provider, input.bucket, input.keys]
    );
    return new Set(result.rows.map((row) => row.object_key));
  }
}

export interface OrphanCleanupOptions {
  storage: ObjectStorage;
  catalog: StorageObjectCatalog;
  bucket: string;
  legacyStorageRoot?: string;
  objectIds?: readonly string[];
  prefix?: string;
  owner?: string;
  now?: Date;
  graceMs?: number;
  leaseSeconds?: number;
  limit?: number;
  deleteUntracked?: boolean;
  signal?: AbortSignal;
}

export interface OrphanCleanupReport {
  owner: string;
  deletedTrackedIds: readonly string[];
  failedTracked: readonly { id: string; error: string }[];
  remainingTrackedCount: number;
  deletedUntrackedCount: number;
  skippedRecentUntrackedCount: number;
  deletedUntrackedKeys: readonly string[];
  skippedRecentUntrackedKeys: readonly string[];
}

function oldEnough(object: ListedObject, cutoffMs: number): boolean {
  return object.lastModified !== undefined && object.lastModified.getTime() <= cutoffMs;
}

export async function cleanupOrphanObjects(
  options: OrphanCleanupOptions
): Promise<OrphanCleanupReport> {
  const owner = options.owner ?? `orphan-cleanup-${randomUUID()}`;
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? 60 * 60 * 1_000;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(graceMs) ||
    graceMs < 60_000 ||
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000
  ) {
    throw new Error("Storage cleanup limits are invalid.");
  }
  const objectIds = normalizeObjectIds(options.objectIds) ?? undefined;
  throwIfCleanupAborted(options.signal);
  const candidates = await options.catalog.claimDeletionCandidates({
    provider: options.storage.provider,
    owner,
    leaseSeconds,
    limit,
    objectIds
  });
  const deletedTrackedIds: string[] = [];
  const failedTracked: { id: string; error: string }[] = [];
  let candidateIndex = 0;
  try {
    throwIfCleanupAborted(options.signal);
    for (; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      throwIfCleanupAborted(options.signal);
      try {
        const deleted = await options.catalog.deleteClaimed(candidate.id, owner, async () => {
          throwIfCleanupAborted(options.signal);
          if (candidate.legacyStoragePath) {
            if (!options.legacyStorageRoot) {
              throw new StorageError(
                "INVALID_LOCATION",
                "Legacy storage cleanup requires a configured storage root."
              );
            }
            await deleteLegacyStorageFile(
              options.legacyStorageRoot,
              candidate.legacyStoragePath
            );
          } else {
            if (candidate.provider !== options.storage.provider) {
              throw new StorageError(
                "INVALID_LOCATION",
                "Storage cleanup target uses an unavailable provider."
              );
            }
            await options.storage.delete(candidate.location);
          }
          throwIfCleanupAborted(options.signal);
        });
        if (deleted) {
          deletedTrackedIds.push(candidate.id);
        } else {
          failedTracked.push({
            id: candidate.id,
            error: "Storage cleanup lease expired or was reassigned before deletion began."
          });
        }
      } catch (error) {
        const sanitized = sanitizeCleanupError(error);
        await options.catalog.markDeleteFailed(candidate.id, owner, sanitized);
        throwIfCleanupAborted(options.signal);
        failedTracked.push({ id: candidate.id, error: sanitized });
      }
      throwIfCleanupAborted(options.signal);
    }
  } catch (error) {
    if (options.signal?.aborted) {
      for (const candidate of candidates.slice(candidateIndex)) {
        await options.catalog
          .markDeleteFailed(candidate.id, owner, "Storage cleanup was interrupted.")
          .catch(() => undefined);
      }
    }
    throw error;
  }

  throwIfCleanupAborted(options.signal);
  const remainingTrackedCount = await options.catalog.countPendingDeletions({
    provider: options.storage.provider,
    objectIds
  });
  throwIfCleanupAborted(options.signal);

  const deletedUntrackedKeys: string[] = [];
  const skippedRecentUntrackedKeys: string[] = [];
  let deletedUntrackedCount = 0;
  let skippedRecentUntrackedCount = 0;
  if (options.deleteUntracked) {
    throwIfCleanupAborted(options.signal);
    if (!options.storage.listPages) {
      throw new StorageError(
        "STORAGE_UNAVAILABLE",
        "Configured storage does not support bounded paged reconciliation."
      );
    }
    const cutoff = now.getTime() - graceMs;
    for await (const listed of options.storage.listPages({
      prefix: options.prefix,
      pageSize: limit
    })) {
      throwIfCleanupAborted(options.signal);
      const tracked = await options.catalog.trackedKeys({
        provider: options.storage.provider,
        bucket: options.bucket,
        keys: listed.map((object) => object.location.key)
      });
      throwIfCleanupAborted(options.signal);
      for (const object of listed) {
        throwIfCleanupAborted(options.signal);
        if (tracked.has(object.location.key)) continue;
        if (!oldEnough(object, cutoff)) {
          skippedRecentUntrackedCount += 1;
          if (skippedRecentUntrackedKeys.length < UNTRACKED_REPORT_SAMPLE_LIMIT) {
            skippedRecentUntrackedKeys.push(object.location.key);
          }
          continue;
        }
        await options.storage.delete(object.location);
        deletedUntrackedCount += 1;
        if (deletedUntrackedKeys.length < UNTRACKED_REPORT_SAMPLE_LIMIT) {
          deletedUntrackedKeys.push(object.location.key);
        }
        throwIfCleanupAborted(options.signal);
      }
    }
  }
  return {
    owner,
    deletedTrackedIds,
    failedTracked,
    remainingTrackedCount,
    deletedUntrackedCount,
    skippedRecentUntrackedCount,
    deletedUntrackedKeys,
    skippedRecentUntrackedKeys
  };
}
