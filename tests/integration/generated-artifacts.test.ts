import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/lib/db";
import {
  discardGeneratedArtifact,
  persistGeneratedArtifact
} from "@/lib/services/generated-artifacts";
import { LocalObjectStorage } from "@/lib/storage";
import { resetTestDatabase } from "@/tests/helpers/database";

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("generated artifact storage", () => {
  it("preserves a deterministic object after metadata failure and reconciles it on retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "generated-artifact-retry-"));
    try {
      const storage = new LocalObjectStorage({
        root,
        defaultBucket: "private",
        maxReadBytes: 1_000_000
      });
      const input = {
        storage,
        bucket: "private",
        category: "debug" as const,
        artifactId: "metadata-failure-fixture",
        filename: "debug.json",
        contentType: "application/json",
        bytes: new TextEncoder().encode('{"synthetic":true}\n'),
        createdBy: "debug:synthetic",
        maxBytes: 1_000_000
      };
      await query(
        `CREATE OR REPLACE FUNCTION reject_generated_artifact_fixture() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic catalog failure'; END $$`
      );
      await query(
        `CREATE TRIGGER reject_generated_artifact_fixture_trigger
         BEFORE INSERT ON storage_objects FOR EACH ROW
         EXECUTE FUNCTION reject_generated_artifact_fixture()`
      );
      try {
        await expect(persistGeneratedArtifact(input)).rejects.toThrow(
          "synthetic catalog failure"
        );
      } finally {
        await query(
          "DROP TRIGGER IF EXISTS reject_generated_artifact_fixture_trigger ON storage_objects"
        );
        await query("DROP FUNCTION IF EXISTS reject_generated_artifact_fixture()");
      }

      const retained = await storage.list("debug");
      expect(retained).toHaveLength(1);
      const reconciled = await persistGeneratedArtifact(input);
      expect(reconciled).toMatchObject({ replayed: true, key: retained[0].location.key });
      await expect(
        query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM storage_objects WHERE id = $1",
          [reconciled.objectId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a checksummed private artifact once and rejects identity drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "generated-artifact-test-"));
    try {
      const storage = new LocalObjectStorage({
        root,
        defaultBucket: "private",
        maxReadBytes: 1_000_000
      });
      const bytes = new TextEncoder().encode('{"synthetic":true}\n');
      const input = {
        storage,
        bucket: "private",
        category: "evaluations" as const,
        artifactId: "synthetic-evaluation-run",
        filename: "eval-summary.json",
        contentType: "application/json",
        bytes,
        createdBy: "evaluation:synthetic",
        maxBytes: 1_000_000
      };
      const first = await persistGeneratedArtifact(input);
      const replay = await persistGeneratedArtifact(input);
      expect(first).toMatchObject({ replayed: false, byteSize: bytes.byteLength });
      expect(replay).toMatchObject({
        objectId: first.objectId,
        key: first.key,
        sha256: first.sha256,
        replayed: true
      });
      expect(
        await storage.read(
          { bucket: first.bucket, key: first.key },
          { maxBytes: 1_000_000, expectedSha256: first.sha256 }
        )
      ).toEqual(bytes);
      await expect(
        persistGeneratedArtifact({
          ...input,
          bytes: new TextEncoder().encode('{"synthetic":false}\n')
        })
      ).rejects.toMatchObject({ code: "GENERATED_ARTIFACT_CONFLICT" });
      await expect(
        query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM storage_objects WHERE id = $1",
          [first.objectId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await discardGeneratedArtifact({
        storage,
        reference: first,
        reason: "Synthetic compensation fixture"
      });
      expect(await storage.head({ bucket: first.bucket, key: first.key })).toBeNull();
      await expect(
        query<{ retention_status: string; upload_status: string }>(
          "SELECT retention_status, upload_status FROM storage_objects WHERE id = $1",
          [first.objectId]
        )
      ).resolves.toMatchObject({
        rows: [{ retention_status: "DELETED", upload_status: "DELETED" }]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
