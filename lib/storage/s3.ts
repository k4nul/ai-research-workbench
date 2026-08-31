import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  StorageError,
  assertSha256,
  sha256Hex,
  validateBucket,
  validateListPageSize,
  validateObjectKey,
  validatePutInput,
  type ListedObject,
  type ListObjectPagesOptions,
  type ObjectStorage,
  type PutObjectInput,
  type ReadObjectOptions,
  type StorageLocation,
  type StoredObject
} from "./types";

export interface S3ObjectStorageOptions {
  client: S3Client;
  bucket: string;
  maxReadBytes?: number;
  maxSignedUrlSeconds?: number;
}

type S3ResponseBody = NonNullable<GetObjectCommandOutput["Body"]>;

async function stopS3Body(
  body: S3ResponseBody,
  reason: Error,
  reader?: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  const controlled = body as S3ResponseBody & {
    cancel?: (reason?: unknown) => Promise<void> | void;
    destroy?: () => unknown;
    destroyed?: boolean;
  };
  let destroyedDirectly = false;
  try {
    if (reader) {
      await reader.cancel(reason);
    } else if (typeof controlled.cancel === "function") {
      await controlled.cancel(reason);
    } else if (typeof controlled.destroy === "function") {
      controlled.destroy();
      destroyedDirectly = true;
    } else {
      await body.transformToWebStream().cancel(reason);
    }
  } catch {
    // Preserve the bounded read error; cancellation failures are secondary.
  }
  if (
    !destroyedDirectly &&
    typeof controlled.destroy === "function" &&
    controlled.destroyed !== true
  ) {
    try {
      controlled.destroy();
    } catch {
      // The primary read error remains authoritative.
    }
  }
}

async function readS3Body(body: S3ResponseBody, limit: number): Promise<Uint8Array> {
  const stream = body.transformToWebStream() as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stopped = false;
  const stop = async (reason: Error): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopS3Body(body, reason, reader);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        const error = new StorageError(
          "STORAGE_UNAVAILABLE",
          "S3 object body returned a non-binary chunk."
        );
        await stop(error);
        throw error;
      }
      if (value.byteLength > limit - total) {
        const error = new StorageError(
          "OBJECT_TOO_LARGE",
          "Storage object exceeds the read limit."
        );
        await stop(error);
        throw error;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await stop(error instanceof Error ? error : new Error("S3 object stream failed."));
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly provider = "S3" as const;
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly maxReadBytes: number;
  private readonly maxSignedUrlSeconds: number;

  constructor(options: S3ObjectStorageOptions) {
    this.client = options.client;
    this.bucketName = validateBucket(options.bucket);
    this.maxReadBytes = options.maxReadBytes ?? 100_000_000;
    this.maxSignedUrlSeconds = options.maxSignedUrlSeconds ?? 900;
    if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes <= 0) {
      throw new StorageError("INVALID_OBJECT", "maxReadBytes must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(this.maxSignedUrlSeconds) ||
      this.maxSignedUrlSeconds < 1 ||
      this.maxSignedUrlSeconds > 3_600
    ) {
      throw new StorageError("INVALID_OBJECT", "Signed URL lifetime is outside the safe range.");
    }
  }

  private location(location: StorageLocation): { bucket: string; key: string } {
    const bucket = validateBucket(location.bucket ?? this.bucketName);
    if (bucket !== this.bucketName) {
      throw new StorageError("INVALID_LOCATION", "Storage location targets an unconfigured bucket.");
    }
    return { bucket, key: validateObjectKey(location.key) };
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const expected = validatePutInput(input);
    if (expected.byteSize > this.maxReadBytes) {
      throw new StorageError("OBJECT_TOO_LARGE", "Storage object exceeds the configured limit.");
    }
    const location = this.location(input.location);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: location.bucket,
          Key: location.key,
          Body: input.bytes,
          ContentLength: expected.byteSize,
          ContentType: input.contentType,
          IfNoneMatch: "*",
          Metadata: { ...input.metadata, sha256: expected.sha256 }
        })
      );
      const stored = await this.head(location);
      if (
        !stored ||
        stored.byteSize !== expected.byteSize ||
        stored.sha256 !== expected.sha256
      ) {
        await this.delete(location).catch(() => undefined);
        throw new StorageError("INTEGRITY_MISMATCH", "S3 object metadata failed verification.");
      }
      return { ...stored, contentType: input.contentType };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412) {
        throw new StorageError("OBJECT_EXISTS", "Storage object already exists.", { cause: error });
      }
      if (status === 409) {
        throw new StorageError(
          "STORAGE_UNAVAILABLE",
          "S3 conditional write conflicted and should be retried.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async read(location: StorageLocation, options: ReadObjectOptions): Promise<Uint8Array> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new StorageError("INVALID_OBJECT", "maxBytes must be a positive integer.");
    }
    const target = this.location(location);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: target.bucket, Key: target.key })
      );
      const limit = Math.min(options.maxBytes, this.maxReadBytes);
      if (!response.Body) {
        throw new StorageError("OBJECT_NOT_FOUND", "Storage object has no response body.");
      }
      if (response.ContentLength !== undefined && response.ContentLength > limit) {
        const error = new StorageError(
          "OBJECT_TOO_LARGE",
          "Storage object exceeds the read limit."
        );
        await stopS3Body(response.Body, error);
        throw error;
      }
      const bytes = await readS3Body(response.Body, limit);
      const sha256 = sha256Hex(bytes);
      const expectedSha256 = options.expectedSha256 ?? response.Metadata?.sha256;
      if (expectedSha256 && assertSha256(expectedSha256) !== sha256) {
        throw new StorageError("INTEGRITY_MISMATCH", "S3 object SHA-256 differs from metadata.");
      }
      return bytes;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      const status =
        error && typeof error === "object"
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
          : undefined;
      if (status === 404) {
        throw new StorageError("OBJECT_NOT_FOUND", "Storage object does not exist.", { cause: error });
      }
      throw new StorageError("STORAGE_UNAVAILABLE", "S3 object read failed.", { cause: error });
    }
  }

  async head(location: StorageLocation): Promise<StoredObject | null> {
    const target = this.location(location);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: target.bucket, Key: target.key })
      );
      return {
        location: target,
        byteSize: response.ContentLength ?? 0,
        sha256: response.Metadata?.sha256,
        contentType: response.ContentType,
        etag: response.ETag,
        lastModified: response.LastModified
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        return null;
      }
      throw error;
    }
  }

  async delete(location: StorageLocation): Promise<void> {
    const target = this.location(location);
    await this.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: target.key }));
  }

  async *listPages(
    options: ListObjectPagesOptions
  ): AsyncIterable<readonly ListedObject[]> {
    const normalizedPrefix = options.prefix ? validateObjectKey(options.prefix) : undefined;
    const pageSize = validateListPageSize(options.pageSize);
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: normalizedPrefix,
          MaxKeys: pageSize,
          ContinuationToken: continuationToken
        })
      );
      const page: ListedObject[] = [];
      for (const object of response.Contents ?? []) {
        if (!object.Key) {
          continue;
        }
        page.push({
          location: { bucket: this.bucketName, key: validateObjectKey(object.Key) },
          byteSize: object.Size ?? 0,
          lastModified: object.LastModified,
          etag: object.ETag
        });
      }
      if (page.length > 0) {
        yield page;
      }
      if (response.IsTruncated && !response.NextContinuationToken) {
        throw new StorageError(
          "STORAGE_UNAVAILABLE",
          "S3 listing was truncated without a continuation token."
        );
      }
      if (
        response.IsTruncated &&
        response.NextContinuationToken &&
        response.NextContinuationToken === continuationToken
      ) {
        throw new StorageError(
          "STORAGE_UNAVAILABLE",
          "S3 listing repeated a continuation token."
        );
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  async list(prefix = ""): Promise<readonly ListedObject[]> {
    const result: ListedObject[] = [];
    for await (const page of this.listPages({ prefix: prefix || undefined, pageSize: 1_000 })) {
      result.push(...page);
    }
    return result;
  }

  async createDownloadUrl(
    location: StorageLocation,
    expiresInSeconds: number
  ): Promise<string> {
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > this.maxSignedUrlSeconds
    ) {
      throw new StorageError("INVALID_OBJECT", "Signed URL lifetime is outside the safe range.");
    }
    const target = this.location(location);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: target.bucket, Key: target.key }),
      { expiresIn: expiresInSeconds }
    );
  }
}
