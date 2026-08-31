import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOrphanObjects,
  type CleanupCandidate,
  type StorageObjectCatalog
} from "@/lib/services/orphan-cleanup";
import { StorageError, type ObjectStorage } from "@/lib/storage";

const temporaryDirectories: string[] = [];

function storage(deleteObject: ObjectStorage["delete"]): ObjectStorage {
  return {
    provider: "LOCAL",
    put: vi.fn(async () => {
      throw new Error("Unexpected put.");
    }),
    read: vi.fn(async () => {
      throw new Error("Unexpected read.");
    }),
    head: vi.fn(async () => null),
    delete: deleteObject,
    list: vi.fn(async () => []),
    createDownloadUrl: vi.fn(async () => null)
  };
}

function catalog(candidates: readonly CleanupCandidate[]) {
  let pendingCount = candidates.length;
  const failed: string[] = [];
  const value: StorageObjectCatalog = {
    claimDeletionCandidates: vi.fn(async () => candidates),
    countPendingDeletions: vi.fn(async () => pendingCount),
    deleteClaimed: vi.fn(async (_id, _owner, operation) => {
      await operation();
      pendingCount -= 1;
      return true;
    }),
    markDeleteFailed: vi.fn(async (id) => {
      if (!failed.includes(id)) failed.push(id);
    }),
    trackedKeys: vi.fn(async () => new Set<string>())
  };
  return { value, failed };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("storage cleanup reconciliation", () => {
  it("reports tracked delete failures and leaves them pending for a retry", async () => {
    const candidate = {
      id: "pending-object",
      provider: "LOCAL" as const,
      location: { bucket: "private", key: "sources/pe/pending-object" }
    };
    const fakeCatalog = catalog([candidate]);
    const report = await cleanupOrphanObjects({
      storage: storage(async () => {
        throw new StorageError("STORAGE_UNAVAILABLE", "Synthetic storage outage.");
      }),
      catalog: fakeCatalog.value,
      bucket: "private",
      objectIds: [candidate.id]
    });

    expect(report).toMatchObject({
      deletedTrackedIds: [],
      failedTracked: [{ id: candidate.id, error: "Synthetic storage outage." }],
      remainingTrackedCount: 1
    });
    expect(fakeCatalog.failed).toEqual([candidate.id]);
  });

  it("stops before the next delete when its abort signal fires", async () => {
    const controller = new AbortController();
    const candidates = ["first-object", "second-object"].map((id) => ({
      id,
      provider: "LOCAL" as const,
      location: { bucket: "private", key: `sources/${id.slice(0, 2)}/${id}` }
    }));
    const fakeCatalog = catalog(candidates);
    const deleted: string[] = [];

    await expect(
      cleanupOrphanObjects({
        storage: storage(async (location) => {
          deleted.push(location.key);
          controller.abort(new Error("Synthetic cleanup cancellation."));
        }),
        catalog: fakeCatalog.value,
        bucket: "private",
        objectIds: candidates.map((candidate) => candidate.id),
        signal: controller.signal
      })
    ).rejects.toThrow("Synthetic cleanup cancellation.");

    expect(deleted).toEqual([candidates[0].location.key]);
    expect(fakeCatalog.failed).toEqual(candidates.map((candidate) => candidate.id));
  });

  it("deletes a contained regular legacy file through the fenced catalog operation", async () => {
    const root = await temporaryRoot("research-legacy-cleanup-");
    const legacyPath = path.join(root, "uploads", "project-1", "evidence.txt");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "synthetic legacy evidence", { mode: 0o600 });
    const candidate = {
      id: "legacy-object",
      provider: "LOCAL" as const,
      location: { bucket: "private", key: "legacy/uploads/legacy-object" },
      legacyStoragePath: legacyPath
    };
    const fakeCatalog = catalog([candidate]);

    const report = await cleanupOrphanObjects({
      storage: storage(vi.fn(async () => undefined)),
      catalog: fakeCatalog.value,
      bucket: "private",
      legacyStorageRoot: root,
      objectIds: [candidate.id]
    });

    expect(report).toMatchObject({
      deletedTrackedIds: [candidate.id],
      failedTracked: [],
      remainingTrackedCount: 0
    });
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a legacy path outside the configured storage categories", async () => {
    const root = await temporaryRoot("research-legacy-root-");
    const outside = await temporaryRoot("research-legacy-outside-");
    const legacyPath = path.join(outside, "do-not-delete.txt");
    await writeFile(legacyPath, "must remain", { mode: 0o600 });
    const candidate = {
      id: "hostile-legacy-object",
      provider: "LOCAL" as const,
      location: { bucket: "private", key: "legacy/uploads/hostile-legacy-object" },
      legacyStoragePath: legacyPath
    };
    const fakeCatalog = catalog([candidate]);

    const report = await cleanupOrphanObjects({
      storage: storage(vi.fn(async () => undefined)),
      catalog: fakeCatalog.value,
      bucket: "private",
      legacyStorageRoot: root,
      objectIds: [candidate.id]
    });

    expect(report).toMatchObject({
      deletedTrackedIds: [],
      failedTracked: [
        {
          id: candidate.id,
          error: "Legacy storage path escaped the configured storage categories."
        }
      ],
      remainingTrackedCount: 1
    });
    await expect(readFile(legacyPath, "utf8")).resolves.toBe("must remain");
  });

  it("continues across bounded pages to reach later untracked orphans", async () => {
    const deleted: string[] = [];
    const pagedStorage = storage(async (location) => {
      deleted.push(location.key);
    });
    pagedStorage.list = vi.fn(async () => {
      throw new Error("Unbounded listing must not be used by cleanup.");
    });
    pagedStorage.listPages = async function* () {
      yield [
        {
          location: { bucket: "private", key: "sources/aa/tracked-a" },
          byteSize: 1,
          lastModified: new Date("2020-01-01")
        },
        {
          location: { bucket: "private", key: "sources/aa/tracked-b" },
          byteSize: 1,
          lastModified: new Date("2020-01-01")
        }
      ];
      yield [
        {
          location: { bucket: "private", key: "sources/zz/orphan" },
          byteSize: 1,
          lastModified: new Date("2020-01-01")
        }
      ];
    };
    const fakeCatalog = catalog([]);
    fakeCatalog.value.trackedKeys = vi.fn(
      async (input: Parameters<StorageObjectCatalog["trackedKeys"]>[0]) =>
        new Set<string>(input.keys.filter((key) => key.includes("tracked")))
    );

    const report = await cleanupOrphanObjects({
      storage: pagedStorage,
      catalog: fakeCatalog.value,
      bucket: "private",
      deleteUntracked: true,
      graceMs: 60_000,
      limit: 2,
      now: new Date("2026-01-01")
    });

    expect(pagedStorage.list).not.toHaveBeenCalled();
    expect(fakeCatalog.value.trackedKeys).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual(["sources/zz/orphan"]);
    expect(report.deletedUntrackedCount).toBe(1);
    expect(report.deletedUntrackedKeys).toEqual(["sources/zz/orphan"]);
  });

  it("bounds untracked report samples while retaining exact counts", async () => {
    const pagedStorage = storage(vi.fn(async () => undefined));
    pagedStorage.listPages = async function* () {
      for (let index = 0; index < 105; index += 1) {
        yield [
          {
            location: {
              bucket: "private",
              key: `sources/zz/orphan-${index.toString().padStart(3, "0")}`
            },
            byteSize: 1,
            lastModified: new Date("2020-01-01")
          }
        ];
      }
    };
    const fakeCatalog = catalog([]);

    const report = await cleanupOrphanObjects({
      storage: pagedStorage,
      catalog: fakeCatalog.value,
      bucket: "private",
      deleteUntracked: true,
      graceMs: 60_000,
      limit: 1,
      now: new Date("2026-01-01")
    });

    expect(report.deletedUntrackedCount).toBe(105);
    expect(report.deletedUntrackedKeys).toHaveLength(100);
  });
});
