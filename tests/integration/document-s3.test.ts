import { randomUUID } from "node:crypto";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  S3ObjectStorage,
  createObjectKey,
  sha256Hex
} from "@/lib/storage";

const endpoint = process.env.S3_TEST_ENDPOINT ?? "http://127.0.0.1:59000";
const region = process.env.S3_TEST_REGION ?? "us-east-1";
const bucket = process.env.S3_TEST_BUCKET ?? "research-workbench";
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID ?? "research-minio";
const secretAccessKey =
  process.env.S3_TEST_SECRET_ACCESS_KEY ?? "local-minio-password-change-me";
const required = process.env.REQUIRE_S3_TEST === "true";

describe("S3-compatible private object storage", () => {
  it("round-trips, lists, privately denies, presigns, and deletes against local MinIO when reachable", async (context) => {
    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 }
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      client.destroy();
      if (required) {
        throw new Error("Required MinIO integration service is unavailable.", { cause: error });
      }
      context.skip();
      return;
    }

    const storage = new S3ObjectStorage({
      client,
      bucket,
      maxReadBytes: 1_000_000,
      maxSignedUrlSeconds: 60
    });
    const key = createObjectKey("quarantine", randomUUID());
    const location = { bucket, key };
    const bytes = new TextEncoder().encode("private MinIO integration fixture");
    try {
      const stored = await storage.put({
        location,
        bytes,
        contentType: "text/plain",
        expectedByteSize: bytes.byteLength,
        expectedSha256: sha256Hex(bytes)
      });
      expect(stored).toMatchObject({
        location,
        byteSize: bytes.byteLength,
        sha256: sha256Hex(bytes)
      });
      expect(
        new TextDecoder().decode(
          await storage.read(location, {
            maxBytes: 1_000,
            expectedSha256: stored.sha256
          })
        )
      ).toBe("private MinIO integration fixture");
      await expect(
        storage.read(location, { maxBytes: 8, expectedSha256: stored.sha256 })
      ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
      expect((await storage.list(key.split("/").slice(0, 2).join("/"))).some(
        (entry) => entry.location.key === key
      )).toBe(true);

      const anonymous = await fetch(`${endpoint}/${bucket}/${key}`);
      expect(anonymous.ok).toBe(false);
      const signedUrl = await storage.createDownloadUrl(location, 30);
      expect(signedUrl).toBeTruthy();
      const signed = await fetch(signedUrl!);
      expect(signed.status).toBe(200);
      expect(await signed.text()).toBe("private MinIO integration fixture");
    } finally {
      await storage.delete(location).catch(() => undefined);
      expect(await storage.head(location)).toBeNull();
      client.destroy();
    }
  });
});
