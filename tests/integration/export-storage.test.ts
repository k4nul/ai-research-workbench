import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getConfig } from "@/lib/config";
import { closePool, query } from "@/lib/db";
import { loadExportData } from "@/lib/export/generate";
import {
  findReusableExport,
  persistExportArtifact
} from "@/lib/services/export-storage";
import {
  cleanupOrphanObjects,
  PostgresStorageObjectCatalog
} from "@/lib/services/orphan-cleanup";
import { createProject } from "@/lib/services/projects";
import {
  LocalObjectStorage,
  StorageError,
  type ObjectStorage,
  type PutObjectInput,
  type StoredObject
} from "@/lib/storage";
import { resetTestDatabase } from "@/tests/helpers/database";

const temporaryDirectories: string[] = [];

function intake(name: string) {
  return {
    mode: "detailed" as const,
    name,
    clientName: "Export storage fixture client",
    coreQuestion: "Can one frozen export input produce one private artifact?",
    background: "Synthetic export persistence fixture.",
    purpose: "Verify object and database compensation.",
    audience: "Test reviewer",
    scope: "Synthetic data only.",
    exclusions: "Customer data.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "DOCX", "ZIP"] as const,
    specialRequirements: "No external calls."
  };
}

async function runtime(): Promise<{
  storage: LocalObjectStorage;
  bucket: string;
  maxObjectBytes: number;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "research-export-storage-"));
  temporaryDirectories.push(root);
  return {
    storage: new LocalObjectStorage({
      root,
      defaultBucket: "private",
      maxReadBytes: 1_000_000
    }),
    bucket: "private",
    maxObjectBytes: 1_000_000
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function failedReusableExport(name: string) {
  const project = await createProject(intake(name));
  const data = await loadExportData(project.id);
  const configured = await runtime();
  const artifact = {
    format: "MARKDOWN" as const,
    filename: "final-report.md",
    mimeType: "text/markdown; charset=utf-8",
    buffer: Buffer.from(`# ${name}\n`)
  };
  const persisted = await persistExportArtifact({
    projectId: project.id,
    snapshot: data.snapshot,
    artifact,
    requireApproval: false,
    runtime: configured,
    durationMs: 5
  });
  const object = await query<{ storage_object_id: string; object_key: string }>(
    `SELECT pe.storage_object_id, so.object_key
     FROM project_exports pe
     JOIN storage_objects so ON so.id = pe.storage_object_id
     WHERE pe.id = $1`,
    [persisted.exportId]
  );
  await query(
    "UPDATE project_exports SET persistence_status = 'FAILED', is_current = FALSE, " +
      "sanitized_error = 'Synthetic interrupted persistence.' WHERE id = $1",
    [persisted.exportId]
  );
  await query(
    "UPDATE storage_objects SET retention_status = 'PENDING_DELETE', " +
      "last_error = 'Synthetic interrupted persistence.', updated_at = NOW() WHERE id = $1",
    [object.rows[0].storage_object_id]
  );
  return {
    project,
    snapshot: data.snapshot,
    configured,
    artifact,
    exportId: persisted.exportId,
    objectId: object.rows[0].storage_object_id,
    location: { bucket: configured.bucket, key: object.rows[0].object_key }
  };
}

async function waitForLeaseExpiry(observer: Client, objectId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await observer.query<{ expired: boolean }>(
      `SELECT cleanup_lease_expires_at <= clock_timestamp() AS expired
       FROM storage_objects WHERE id = $1`,
      [objectId]
    );
    if (result.rows[0]?.expired) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForBlockedReactivation(observer: Client): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE 'UPDATE storage_objects SET upload_status = ''AVAILABLE''%'
       ) AS blocked`
    );
    if (result.rows[0].blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  await closePool();
});

describe("idempotent export object persistence", () => {
  it("reuses one verified object across concurrent submission and response replay", async () => {
    const project = await createProject(intake("Concurrent export persistence"));
    const data = await loadExportData(project.id);
    const configured = await runtime();
    const artifact = {
      format: "MARKDOWN" as const,
      filename: "final-report.md",
      mimeType: "text/markdown; charset=utf-8",
      buffer: Buffer.from("# Deterministic synthetic export\n")
    };
    const persist = () =>
      persistExportArtifact({
        projectId: project.id,
        snapshot: data.snapshot,
        artifact,
        requireApproval: false,
        runtime: configured,
        durationMs: 5
      });

    const [first, concurrent] = await Promise.all([persist(), persist()]);
    const replay = await persist();
    expect(concurrent.exportId).toBe(first.exportId);
    expect(replay.exportId).toBe(first.exportId);
    expect(replay.buffer.equals(artifact.buffer)).toBe(true);
    await expect(
      query<{ exports: number; objects: number }>(
        `SELECT COUNT(DISTINCT pe.id)::integer AS exports,
          COUNT(DISTINCT so.id)::integer AS objects
         FROM project_exports pe
         JOIN storage_objects so ON so.id = pe.storage_object_id
         WHERE pe.project_id = $1`,
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ exports: 1, objects: 1 }] });
  });

  it("marks an uploaded object for cleanup when the frozen snapshot changes before finalize", async () => {
    const project = await createProject(intake("Stale export compensation"));
    const data = await loadExportData(project.id);
    const configured = await runtime();
    const mutatingStorage: ObjectStorage = {
      ...configured.storage,
      provider: configured.storage.provider,
      put: async (input: PutObjectInput): Promise<StoredObject> => {
        const stored = await configured.storage.put(input);
        await query(
          "UPDATE research_projects SET name = name || ' changed', " +
            "updated_at = updated_at + INTERVAL '1 second' WHERE id = $1",
          [project.id]
        );
        return stored;
      },
      read: configured.storage.read.bind(configured.storage),
      head: configured.storage.head.bind(configured.storage),
      delete: configured.storage.delete.bind(configured.storage),
      list: configured.storage.list.bind(configured.storage),
      createDownloadUrl: configured.storage.createDownloadUrl.bind(configured.storage)
    };

    await expect(
      persistExportArtifact({
        projectId: project.id,
        snapshot: data.snapshot,
        artifact: {
          format: "PDF",
          filename: "final-report.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("synthetic-stale-object")
        },
        requireApproval: false,
        runtime: { ...configured, storage: mutatingStorage },
        durationMs: 10
      })
    ).rejects.toMatchObject({ code: "EXPORT_STALE" });
    await expect(
      query<{ persistence_status: string; retention_status: string }>(
        `SELECT pe.persistence_status, so.retention_status
         FROM project_exports pe JOIN storage_objects so ON so.id = pe.storage_object_id
         WHERE pe.project_id = $1`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ persistence_status: "FAILED", retention_status: "PENDING_DELETE" }]
    });
  });

  it("does not resurrect an export object deleted by cleanup after a late write failure", async () => {
    const project = await createProject(intake("Late export failure cleanup fence"));
    const data = await loadExportData(project.id);
    const configured = await runtime();
    const racingStorage: ObjectStorage = {
      ...configured.storage,
      provider: configured.storage.provider,
      put: async (input: PutObjectInput): Promise<StoredObject> => {
        await configured.storage.put(input);
        await configured.storage.delete(input.location);
        await query(
          `UPDATE storage_objects SET upload_status = 'DELETED',
            retention_status = 'DELETED', deleted_at = NOW(), updated_at = NOW()
           WHERE project_id = $1 AND bucket = $2 AND object_key = $3`,
          [project.id, input.location.bucket, input.location.key]
        );
        throw new StorageError(
          "STORAGE_UNAVAILABLE",
          "Synthetic late export failure after cleanup completed."
        );
      },
      read: configured.storage.read.bind(configured.storage),
      head: configured.storage.head.bind(configured.storage),
      delete: configured.storage.delete.bind(configured.storage),
      list: configured.storage.list.bind(configured.storage),
      createDownloadUrl: configured.storage.createDownloadUrl.bind(configured.storage)
    };

    await expect(
      persistExportArtifact({
        projectId: project.id,
        snapshot: data.snapshot,
        artifact: {
          format: "PDF",
          filename: "final-report.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("synthetic-late-export-failure")
        },
        requireApproval: false,
        runtime: { ...configured, storage: racingStorage },
        durationMs: 10
      })
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });

    const persisted = await query<{
      persistence_status: string;
      upload_status: string;
      retention_status: string;
      bucket: string;
      object_key: string;
    }>(
      `SELECT pe.persistence_status, so.upload_status, so.retention_status,
        so.bucket, so.object_key
       FROM project_exports pe
       JOIN storage_objects so ON so.id = pe.storage_object_id
       WHERE pe.project_id = $1`,
      [project.id]
    );
    expect(persisted.rows).toMatchObject([
      {
        persistence_status: "FAILED",
        upload_status: "DELETED",
        retention_status: "DELETED"
      }
    ]);
    await expect(
      configured.storage.head({
        bucket: persisted.rows[0].bucket,
        key: persisted.rows[0].object_key
      })
    ).resolves.toBeNull();
  });

  it("lets export recovery win after a cleanup claim expires but before deletion is fenced", async () => {
    const fixture = await failedReusableExport("Expired cleanup claim recovery");
    const catalog = new PostgresStorageObjectCatalog();
    const candidates = await catalog.claimDeletionCandidates({
      provider: fixture.configured.storage.provider,
      owner: "expired-export-cleanup",
      leaseSeconds: 30,
      limit: 1
    });
    expect(candidates).toHaveLength(1);
    await query(
      "UPDATE storage_objects SET cleanup_lease_expires_at = clock_timestamp() - INTERVAL '1 second' " +
        "WHERE id = $1 AND cleanup_lease_owner = $2",
      [fixture.objectId, "expired-export-cleanup"]
    );

    const recovered = await findReusableExport({
      projectId: fixture.project.id,
      format: fixture.artifact.format,
      snapshot: fixture.snapshot,
      runtime: fixture.configured,
      recoverIncomplete: true
    });
    expect(recovered).toMatchObject({ exportId: fixture.exportId });
    let deleteCalled = false;
    const cleanup = await cleanupOrphanObjects({
      storage: {
        ...fixture.configured.storage,
        provider: fixture.configured.storage.provider,
        put: fixture.configured.storage.put.bind(fixture.configured.storage),
        read: fixture.configured.storage.read.bind(fixture.configured.storage),
        head: fixture.configured.storage.head.bind(fixture.configured.storage),
        delete: async () => {
          deleteCalled = true;
        },
        list: fixture.configured.storage.list.bind(fixture.configured.storage),
        createDownloadUrl: fixture.configured.storage.createDownloadUrl.bind(
          fixture.configured.storage
        )
      },
      catalog: {
        claimDeletionCandidates: async () => candidates,
        countPendingDeletions: catalog.countPendingDeletions.bind(catalog),
        deleteClaimed: catalog.deleteClaimed.bind(catalog),
        markDeleteFailed: catalog.markDeleteFailed.bind(catalog),
        trackedKeys: catalog.trackedKeys.bind(catalog)
      },
      bucket: fixture.configured.bucket,
      owner: "expired-export-cleanup",
      leaseSeconds: 30,
      limit: 1
    });
    expect(cleanup).toMatchObject({
      deletedTrackedIds: [],
      failedTracked: [
        {
          id: fixture.objectId,
          error: "Storage cleanup lease expired or was reassigned before deletion began."
        }
      ]
    });
    expect(deleteCalled).toBe(false);
    expect(await fixture.configured.storage.head(fixture.location)).not.toBeNull();
    await expect(
      query<{ retention_status: string; cleanup_lease_owner: string | null }>(
        "SELECT retention_status, cleanup_lease_owner FROM storage_objects WHERE id = $1",
        [fixture.objectId]
      )
    ).resolves.toMatchObject({
      rows: [{ retention_status: "ACTIVE", cleanup_lease_owner: null }]
    });
  });

  it("fences physical deletion from an expired-lease export reactivation race", async () => {
    const fixture = await failedReusableExport("Fenced cleanup race");
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    const recoveryRead = deferred();
    let observeRecoveryRead = false;
    const coordinatedStorage: ObjectStorage = {
      ...fixture.configured.storage,
      provider: fixture.configured.storage.provider,
      put: fixture.configured.storage.put.bind(fixture.configured.storage),
      read: async (location, options) => {
        const bytes = await fixture.configured.storage.read(location, options);
        if (observeRecoveryRead) recoveryRead.resolve();
        return bytes;
      },
      head: fixture.configured.storage.head.bind(fixture.configured.storage),
      delete: async (location) => {
        deleteEntered.resolve();
        await releaseDelete.promise;
        await fixture.configured.storage.delete(location);
      },
      list: fixture.configured.storage.list.bind(fixture.configured.storage),
      createDownloadUrl: fixture.configured.storage.createDownloadUrl.bind(
        fixture.configured.storage
      )
    };
    const observer = new Client({ connectionString: getConfig().databaseUrl });
    await observer.connect();
    let cleanupPromise: ReturnType<typeof cleanupOrphanObjects> | undefined;
    let recoveryResult:
      | Promise<
          | { status: "fulfilled"; value: Awaited<ReturnType<typeof findReusableExport>> }
          | { status: "rejected"; reason: unknown }
        >
      | undefined;
    try {
      cleanupPromise = cleanupOrphanObjects({
        storage: coordinatedStorage,
        catalog: new PostgresStorageObjectCatalog(),
        bucket: fixture.configured.bucket,
        owner: "fenced-export-cleanup",
        leaseSeconds: 1,
        limit: 1
      });
      await deleteEntered.promise;
      expect(await waitForLeaseExpiry(observer, fixture.objectId)).toBe(true);

      observeRecoveryRead = true;
      recoveryResult = findReusableExport({
        projectId: fixture.project.id,
        format: fixture.artifact.format,
        snapshot: fixture.snapshot,
        runtime: { ...fixture.configured, storage: coordinatedStorage },
        recoverIncomplete: true
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason })
      );
      await recoveryRead.promise;
      expect(await waitForBlockedReactivation(observer)).toBe(true);

      releaseDelete.resolve();
      const [cleanup, recovery] = await Promise.all([cleanupPromise, recoveryResult]);
      expect(cleanup.deletedTrackedIds).toEqual([fixture.objectId]);
      expect(recovery).toMatchObject({
        status: "rejected",
        reason: { code: "EXPORT_CLEANUP_BUSY" }
      });
      expect(await fixture.configured.storage.head(fixture.location)).toBeNull();
      await expect(
        query<{ retention_status: string; upload_status: string; persistence_status: string }>(
          `SELECT so.retention_status, so.upload_status, pe.persistence_status
           FROM storage_objects so
           JOIN project_exports pe ON pe.storage_object_id = so.id
           WHERE so.id = $1`,
          [fixture.objectId]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            retention_status: "DELETED",
            upload_status: "DELETED",
            persistence_status: "FAILED"
          }
        ]
      });
    } finally {
      releaseDelete.resolve();
      await cleanupPromise?.catch(() => undefined);
      await recoveryResult;
      await observer.end();
    }
  });
});
