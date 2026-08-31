import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "@/lib/db";
import { MockMalwareScanner, type DocumentRuntime } from "@/lib/documents";
import { cleanupOrphanObjects, PostgresStorageObjectCatalog } from "@/lib/services/orphan-cleanup";
import { getJob, submitJob, type JobRow } from "@/lib/services/jobs";
import {
  LocalObjectStorage,
  StorageError,
  createObjectKey,
  type ObjectStorage
} from "@/lib/storage";
import { resetTestDatabase } from "@/tests/helpers/database";
import { DurableWorker } from "@/worker/durable-worker";
import { createDocumentJobHandlers } from "@/worker/document-handlers";

const temporaryDirectories: string[] = [];

async function localStorage(): Promise<{ root: string; storage: LocalObjectStorage }> {
  const root = await mkdtemp(path.join(tmpdir(), "research-cleanup-worker-"));
  temporaryDirectories.push(root);
  return {
    root,
    storage: new LocalObjectStorage({
      root: path.join(root, "objects"),
      defaultBucket: "private",
      maxReadBytes: 1_000_000
    })
  };
}

function runtime(storage: ObjectStorage): DocumentRuntime {
  return {
    storage,
    scanner: new MockMalwareScanner(),
    storageBucket: "private",
    maxUploadBytes: 1_000_000,
    maxObjectBytes: 1_000_000,
    maxScanBytes: 1_000_000,
    production: true,
    allowExplicitDemoBypass: false
  };
}

function worker(storage: ObjectStorage, suffix: string): DurableWorker {
  return new DurableWorker(createDocumentJobHandlers(runtime(storage)), {
    workerId: `cleanup-worker-${suffix}`,
    concurrency: 1,
    pollIntervalMs: 10,
    leaseDurationMs: 2_000,
    heartbeatIntervalMs: 200,
    shutdownGraceMs: 2_000,
    log: () => undefined
  });
}

async function waitForAttempt(durableWorker: DurableWorker, jobId: string): Promise<JobRow> {
  for (let attempt = 0; attempt < 200 && durableWorker.activeJobCount !== 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(durableWorker.activeJobCount).toBe(0);
  return getJob(jobId);
}

async function pendingObject(storage: LocalObjectStorage, id: string) {
  const location = { bucket: "private", key: createObjectKey("sources", id) };
  const stored = await storage.put({
    location,
    bytes: new TextEncoder().encode(`synthetic cleanup fixture ${id}`),
    contentType: "text/plain"
  });
  await query(
    `INSERT INTO storage_objects (
      id, provider, bucket, object_key, content_type, byte_size, sha256,
      integrity_status, upload_status, retention_status
    ) VALUES ($1, 'LOCAL', $2, $3, 'text/plain', $4, $5, 'VERIFIED', 'AVAILABLE', 'PENDING_DELETE')`,
    [id, location.bucket, location.key, stored.byteSize, stored.sha256]
  );
  return location;
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

afterAll(async () => {
  await closePool();
});

describe("durable storage cleanup jobs", () => {
  it("drains every targeted batch without deleting an unrelated pending object", async () => {
    const configured = await localStorage();
    const targetIds = [
      "1111111111111111",
      "2222222222222222"
    ];
    const unrelatedId = "3333333333333333";
    const targetLocations = await Promise.all(
      targetIds.map((id) => pendingObject(configured.storage, id))
    );
    const unrelatedLocation = await pendingObject(configured.storage, unrelatedId);
    const submitted = await submitJob({
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, limit: 1, objectIds: targetIds },
      idempotencyKey: "targeted-cleanup-drain"
    });
    const durableWorker = worker(configured.storage, "drain");

    expect(await durableWorker.runOnce()).toBe(1);
    const completed = await waitForAttempt(durableWorker, submitted.job.id);
    await durableWorker.stop();

    expect(completed).toMatchObject({
      status: "SUCCEEDED",
      output_reference: { batches: 2, deletedTracked: 2 }
    });
    await expect(
      query<{ id: string; retention_status: string }>(
        "SELECT id, retention_status FROM storage_objects ORDER BY id"
      )
    ).resolves.toMatchObject({
      rows: [
        { id: targetIds[0], retention_status: "DELETED" },
        { id: targetIds[1], retention_status: "DELETED" },
        { id: unrelatedId, retention_status: "PENDING_DELETE" }
      ]
    });
    for (const location of targetLocations) {
      expect(await configured.storage.head(location)).toBeNull();
    }
    expect(await configured.storage.head(unrelatedLocation)).not.toBeNull();
  });

  it("runs untracked reconciliation once after every targeted batch drains", async () => {
    const configured = await localStorage();
    const targetIds = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"];
    const targetLocations = await Promise.all(
      targetIds.map((id) => pendingObject(configured.storage, id))
    );
    const untrackedLocation = {
      bucket: "private",
      key: createObjectKey("sources", "cccccccccccccccc")
    };
    await configured.storage.put({
      location: untrackedLocation,
      bytes: new TextEncoder().encode("fresh untracked cleanup fixture"),
      contentType: "text/plain"
    });
    let listPasses = 0;
    const observingStorage: ObjectStorage = {
      provider: configured.storage.provider,
      put: configured.storage.put.bind(configured.storage),
      read: configured.storage.read.bind(configured.storage),
      head: configured.storage.head.bind(configured.storage),
      delete: configured.storage.delete.bind(configured.storage),
      list: configured.storage.list.bind(configured.storage),
      listPages: async function* (options) {
        listPasses += 1;
        yield* configured.storage.listPages(options);
      },
      createDownloadUrl: configured.storage.createDownloadUrl.bind(configured.storage)
    };
    const submitted = await submitJob({
      jobType: "STORAGE_CLEANUP",
      inputReference: {
        deleteUntracked: true,
        graceMs: 60_000,
        limit: 1,
        objectIds: targetIds
      },
      idempotencyKey: "targeted-cleanup-single-untracked-pass"
    });
    const durableWorker = worker(observingStorage, "single-untracked-pass");

    expect(await durableWorker.runOnce()).toBe(1);
    const completed = await waitForAttempt(durableWorker, submitted.job.id);
    await durableWorker.stop();

    expect(completed).toMatchObject({
      status: "SUCCEEDED",
      output_reference: {
        batches: 3,
        deletedTracked: 2,
        deletedUntracked: 0,
        skippedRecentUntracked: 1
      }
    });
    expect(listPasses).toBe(1);
    for (const location of targetLocations) {
      expect(await configured.storage.head(location)).toBeNull();
    }
    expect(await configured.storage.head(untrackedLocation)).not.toBeNull();
    await expect(
      query<{ id: string; retention_status: string }>(
        "SELECT id, retention_status FROM storage_objects ORDER BY id"
      )
    ).resolves.toMatchObject({
      rows: targetIds.map((id) => ({ id, retention_status: "DELETED" }))
    });
  });

  it("schedules a retry after a tracked delete failure and succeeds on replay", async () => {
    const configured = await localStorage();
    const objectId = "4444444444444444";
    const location = await pendingObject(configured.storage, objectId);
    let failDelete = true;
    const retryingStorage: ObjectStorage = {
      provider: configured.storage.provider,
      put: configured.storage.put.bind(configured.storage),
      read: configured.storage.read.bind(configured.storage),
      head: configured.storage.head.bind(configured.storage),
      delete: async (target) => {
        if (failDelete) {
          throw new StorageError("STORAGE_UNAVAILABLE", "Synthetic retryable delete failure.");
        }
        await configured.storage.delete(target);
      },
      list: configured.storage.list.bind(configured.storage),
      createDownloadUrl: configured.storage.createDownloadUrl.bind(configured.storage)
    };
    const submitted = await submitJob({
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, objectIds: [objectId] },
      idempotencyKey: "tracked-cleanup-retry",
      maxAttempts: 3
    });
    const durableWorker = worker(retryingStorage, "retry");

    expect(await durableWorker.runOnce()).toBe(1);
    const failedAttempt = await waitForAttempt(durableWorker, submitted.job.id);
    expect(failedAttempt).toMatchObject({
      status: "RETRY_WAIT",
      attempts: 1,
      error_class: "RETRYABLE_STORAGE"
    });
    await expect(
      query<{ retention_status: string; cleanup_lease_owner: string | null }>(
        "SELECT retention_status, cleanup_lease_owner FROM storage_objects WHERE id = $1",
        [objectId]
      )
    ).resolves.toMatchObject({
      rows: [{ retention_status: "PENDING_DELETE", cleanup_lease_owner: null }]
    });

    failDelete = false;
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [submitted.job.id]);
    expect(await durableWorker.runOnce()).toBe(1);
    const replayed = await waitForAttempt(durableWorker, submitted.job.id);
    await durableWorker.stop();

    expect(replayed).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await configured.storage.head(location)).toBeNull();
  });

  it("deletes and catalogs a contained migrated legacy file", async () => {
    const configured = await localStorage();
    const legacyPath = path.join(configured.root, "exports", "project-1", "legacy.pdf");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "synthetic legacy export", { mode: 0o600 });
    const objectId = "legacy-export-cleanup-fixture";
    await query(
      `INSERT INTO storage_objects (
        id, provider, bucket, object_key, content_type, upload_status,
        retention_status, legacy_storage_path
      ) VALUES ($1, 'LOCAL', 'private', $2, 'application/pdf', 'AVAILABLE',
        'PENDING_DELETE', $3)`,
      [objectId, `legacy/exports/${objectId}`, legacyPath]
    );

    const report = await cleanupOrphanObjects({
      storage: configured.storage,
      catalog: new PostgresStorageObjectCatalog(),
      bucket: "private",
      legacyStorageRoot: configured.root,
      objectIds: [objectId]
    });

    expect(report).toMatchObject({
      deletedTrackedIds: [objectId],
      failedTracked: [],
      remainingTrackedCount: 0
    });
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      query<{ retention_status: string; upload_status: string }>(
        "SELECT retention_status, upload_status FROM storage_objects WHERE id = $1",
        [objectId]
      )
    ).resolves.toMatchObject({
      rows: [{ retention_status: "DELETED", upload_status: "DELETED" }]
    });
  });
});
