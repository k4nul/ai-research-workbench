import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
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

export interface LocalObjectStorageOptions {
  root: string;
  defaultBucket?: string;
  maxReadBytes?: number;
}

const READ_CHUNK_BYTES = 64 * 1_024;

type BoundedReadHandle = {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
};

export async function readFileHandleBounded(
  handle: BoundedReadHandle,
  limit: number
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) {
      throw new StorageError("OBJECT_TOO_LARGE", "Storage object exceeds the read limit.");
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class LocalObjectStorage implements ObjectStorage {
  readonly provider = "LOCAL" as const;
  private readonly root: string;
  private readonly defaultBucket: string;
  private readonly maxReadBytes: number;

  constructor(options: LocalObjectStorageOptions) {
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) {
      throw new StorageError("INVALID_LOCATION", "Filesystem root cannot be a storage root.");
    }
    this.defaultBucket = validateBucket(options.defaultBucket ?? "private");
    this.maxReadBytes = options.maxReadBytes ?? 100_000_000;
    if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes <= 0) {
      throw new StorageError("INVALID_OBJECT", "maxReadBytes must be a positive integer.");
    }
  }

  private bucket(location: StorageLocation): string {
    const bucket = validateBucket(location.bucket ?? this.defaultBucket);
    if (bucket !== this.defaultBucket) {
      throw new StorageError("INVALID_LOCATION", "Storage location targets an unconfigured bucket.");
    }
    return bucket;
  }

  private target(location: StorageLocation): { bucket: string; key: string; path: string } {
    const bucket = this.bucket(location);
    const key = validateObjectKey(location.key);
    const bucketRoot = path.resolve(this.root, bucket);
    const target = path.resolve(bucketRoot, ...key.split("/"));
    if (!target.startsWith(bucketRoot + path.sep)) {
      throw new StorageError("INVALID_LOCATION", "Storage path escaped its configured bucket.");
    }
    return { bucket, key, path: target };
  }

  private async ensureSafeParent(target: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const [resolvedRoot, resolvedParent] = await Promise.all([realpath(this.root), realpath(parent)]);
    if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(resolvedRoot + path.sep)) {
      throw new StorageError("INVALID_LOCATION", "Storage parent resolves outside its root.");
    }
  }

  private async openRegularFile(target: string) {
    await this.ensureSafeParent(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      await handle.close();
      throw new StorageError("INVALID_OBJECT", "Storage object is not a regular file.");
    }
    return { handle, fileStat };
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const expected = validatePutInput(input);
    if (expected.byteSize > this.maxReadBytes) {
      throw new StorageError("OBJECT_TOO_LARGE", "Storage object exceeds the configured limit.");
    }
    const target = this.target(input.location);
    await this.ensureSafeParent(target.path);
    let created = false;
    try {
      const handle = await open(
        target.path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600
      );
      created = true;
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size !== expected.byteSize) {
          throw new StorageError("INTEGRITY_MISMATCH", "Filesystem object size changed while writing.");
        }
      } finally {
        await handle.close();
      }
      const persisted = await this.read(input.location, {
        maxBytes: this.maxReadBytes,
        expectedSha256: expected.sha256
      });
      const fileStat = await stat(target.path);
      return {
        location: { bucket: target.bucket, key: target.key },
        byteSize: persisted.byteLength,
        sha256: expected.sha256,
        contentType: input.contentType,
        lastModified: fileStat.mtime
      };
    } catch (error) {
      if (created) {
        await unlink(target.path).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new StorageError("OBJECT_EXISTS", "Storage object already exists.", { cause: error });
      }
      throw error;
    }
  }

  async read(location: StorageLocation, options: ReadObjectOptions): Promise<Uint8Array> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new StorageError("INVALID_OBJECT", "maxBytes must be a positive integer.");
    }
    const target = this.target(location);
    try {
      const { handle, fileStat } = await this.openRegularFile(target.path);
      try {
        const limit = Math.min(options.maxBytes, this.maxReadBytes);
        if (fileStat.size > limit) {
          throw new StorageError("OBJECT_TOO_LARGE", "Storage object exceeds the read limit.");
        }
        const bytes = await readFileHandleBounded(handle, limit);
        const sha256 = sha256Hex(bytes);
        if (options.expectedSha256 && assertSha256(options.expectedSha256) !== sha256) {
          throw new StorageError("INTEGRITY_MISMATCH", "Filesystem object SHA-256 differs from metadata.");
        }
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StorageError("OBJECT_NOT_FOUND", "Storage object does not exist.", { cause: error });
      }
      throw error;
    }
  }

  async head(location: StorageLocation): Promise<StoredObject | null> {
    const target = this.target(location);
    try {
      const bytes = await this.read(location, { maxBytes: this.maxReadBytes });
      const fileStat = await lstat(target.path);
      return {
        location: { bucket: target.bucket, key: target.key },
        byteSize: bytes.byteLength,
        sha256: sha256Hex(bytes),
        lastModified: fileStat.mtime
      };
    } catch (error) {
      if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async delete(location: StorageLocation): Promise<void> {
    const target = this.target(location);
    try {
      await this.ensureSafeParent(target.path);
      const fileStat = await lstat(target.path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new StorageError("INVALID_OBJECT", "Refusing to delete a non-regular storage object.");
      }
      await unlink(target.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async *listPages(
    options: ListObjectPagesOptions
  ): AsyncIterable<readonly ListedObject[]> {
    const normalizedPrefix = options.prefix ? validateObjectKey(options.prefix) : "";
    const pageSize = validateListPageSize(options.pageSize);
    const bucketRoot = path.resolve(this.root, this.defaultBucket);
    const bucket = this.defaultBucket;
    await this.ensureSafeParent(path.join(bucketRoot, ".list-containment-probe"));

    const visit = async function* (directory: string): AsyncGenerator<ListedObject> {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          const relativeDirectory =
            path.relative(bucketRoot, entryPath).split(path.sep).join("/") + "/";
          if (
            normalizedPrefix &&
            !normalizedPrefix.startsWith(relativeDirectory) &&
            !relativeDirectory.startsWith(normalizedPrefix)
          ) {
            continue;
          }
          yield* visit(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const key = path.relative(bucketRoot, entryPath).split(path.sep).join("/");
        if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
          const fileStat = await stat(entryPath);
          yield {
            location: { bucket, key },
            byteSize: fileStat.size,
            lastModified: fileStat.mtime
          };
        }
      }
    };

    let page: ListedObject[] = [];
    for await (const object of visit(bucketRoot)) {
      page.push(object);
      if (page.length === pageSize) {
        yield page;
        page = [];
      }
    }
    if (page.length > 0) {
      yield page;
    }
  }

  async list(prefix = ""): Promise<readonly ListedObject[]> {
    const result: ListedObject[] = [];
    for await (const page of this.listPages({ prefix: prefix || undefined, pageSize: 1_000 })) {
      result.push(...page);
    }
    return result.sort((left, right) => left.location.key.localeCompare(right.location.key));
  }

  async createDownloadUrl(): Promise<null> {
    return null;
  }
}
