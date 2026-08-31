import { createHash, randomUUID } from "node:crypto";

export type StorageProviderKind = "LOCAL" | "S3";

export type StorageErrorCode =
  | "INVALID_LOCATION"
  | "INVALID_OBJECT"
  | "OBJECT_EXISTS"
  | "OBJECT_NOT_FOUND"
  | "OBJECT_TOO_LARGE"
  | "INTEGRITY_MISMATCH"
  | "STORAGE_UNAVAILABLE";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}

export interface StorageLocation {
  bucket?: string;
  key: string;
}

export interface PutObjectInput {
  location: StorageLocation;
  bytes: Uint8Array;
  contentType: string;
  expectedByteSize?: number;
  expectedSha256?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface ReadObjectOptions {
  maxBytes: number;
  expectedSha256?: string;
}

export interface StoredObject {
  location: StorageLocation;
  byteSize: number;
  sha256?: string;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface ListedObject {
  location: StorageLocation;
  byteSize: number;
  lastModified?: Date;
  etag?: string;
}

export interface ListObjectPagesOptions {
  prefix?: string;
  pageSize: number;
}

export interface ObjectStorage {
  readonly provider: StorageProviderKind;
  put(input: PutObjectInput): Promise<StoredObject>;
  read(location: StorageLocation, options: ReadObjectOptions): Promise<Uint8Array>;
  head(location: StorageLocation): Promise<StoredObject | null>;
  delete(location: StorageLocation): Promise<void>;
  list(prefix?: string): Promise<readonly ListedObject[]>;
  listPages?(
    options: ListObjectPagesOptions
  ): AsyncIterable<readonly ListedObject[]>;
  createDownloadUrl(location: StorageLocation, expiresInSeconds: number): Promise<string | null>;
}

export function validateListPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new StorageError("INVALID_OBJECT", "Storage list page size is invalid.");
  }
  return value;
}

const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const OBJECT_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
const OBJECT_CATEGORIES = new Set([
  "debug",
  "evaluations",
  "exports",
  "extractions",
  "quarantine",
  "sources"
]);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new StorageError("INVALID_OBJECT", "SHA-256 must be 64 hexadecimal characters.");
  }
  return normalized;
}

export function validateBucket(value: string): string {
  if (!BUCKET_PATTERN.test(value) || value.includes("..")) {
    throw new StorageError("INVALID_LOCATION", "Storage bucket is invalid.");
  }
  return value;
}

export function validateObjectKey(value: string): string {
  if (
    !value ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\0\r\n\u0001-\u001f\u007f]/.test(value)
  ) {
    throw new StorageError("INVALID_LOCATION", "Storage object key is invalid.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new StorageError("INVALID_LOCATION", "Storage object key contains an unsafe segment.");
  }
  return value;
}

export function createObjectKey(category: string, objectId: string = randomUUID()): string {
  if (!OBJECT_CATEGORIES.has(category)) {
    throw new StorageError("INVALID_LOCATION", "Storage object category is invalid.");
  }
  const normalizedId = objectId.toLowerCase();
  if (!OBJECT_ID_PATTERN.test(normalizedId)) {
    throw new StorageError("INVALID_LOCATION", "Storage object identifier is invalid.");
  }
  return `${category}/${normalizedId.slice(0, 2)}/${normalizedId}`;
}

export function validatePutInput(input: PutObjectInput): { byteSize: number; sha256: string } {
  const byteSize = input.bytes.byteLength;
  if (input.expectedByteSize !== undefined && input.expectedByteSize !== byteSize) {
    throw new StorageError("INTEGRITY_MISMATCH", "Stored byte size does not match expectation.");
  }
  const sha256 = sha256Hex(input.bytes);
  if (input.expectedSha256 && assertSha256(input.expectedSha256) !== sha256) {
    throw new StorageError("INTEGRITY_MISMATCH", "Stored SHA-256 does not match expectation.");
  }
  if (!input.contentType.trim() || input.contentType.length > 200) {
    throw new StorageError("INVALID_OBJECT", "Content type is invalid.");
  }
  validateObjectKey(input.location.key);
  if (input.location.bucket) {
    validateBucket(input.location.bucket);
  }
  return { byteSize, sha256 };
}
