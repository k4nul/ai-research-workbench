import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

vi.mock("@/lib/db", () => database);

import { quarantineDocument } from "@/lib/services/documents";
import { sha256Hex, type ObjectStorage } from "@/lib/storage";

describe("document upload compensation", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.withTransaction.mockReset();
  });

  it("preserves stored bytes when a failed transaction cannot be reconciled", async () => {
    const bytes = new TextEncoder().encode("Synthetic upload compensation fixture.");
    const remove = vi.fn(async () => undefined);
    const storage: ObjectStorage = {
      provider: "LOCAL",
      put: vi.fn(async (input) => ({
        location: { bucket: input.location.bucket ?? "private", key: input.location.key },
        byteSize: input.bytes.byteLength,
        sha256: sha256Hex(input.bytes),
        contentType: input.contentType
      })),
      read: vi.fn(),
      head: vi.fn(),
      delete: remove,
      list: vi.fn(),
      createDownloadUrl: vi.fn()
    };
    database.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "project-fixture" }] })
      .mockRejectedValueOnce(new Error("synthetic reconciliation outage"));
    database.withTransaction.mockRejectedValueOnce(
      new Error("synthetic COMMIT acknowledgement loss")
    );

    await expect(
      quarantineDocument(
        {
          projectId: "project-fixture",
          file: { filename: "fixture.txt", mimeType: "text/plain", bytes },
          source: { title: "Synthetic compensation fixture" },
          actor: { actorType: "USER", actorId: "operator-fixture", label: "Fixture operator" },
          maxBytes: 1_000_000,
          bucket: "private"
        },
        storage
      )
    ).rejects.toMatchObject({
      status: 503,
      code: "QUARANTINE_RECONCILIATION_REQUIRED"
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
