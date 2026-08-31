import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { getConfig, type AppConfig } from "@/lib/config";
import { LocalObjectStorage, S3ObjectStorage, type ObjectStorage } from "@/lib/storage";
import { ClamAvScanner, MockMalwareScanner, type MalwareScanner } from "./scanner";

const LOCAL_STORAGE_BUCKET = "private";

export interface DocumentRuntime {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  storageBucket: string;
  maxUploadBytes: number;
  maxObjectBytes: number;
  maxScanBytes: number;
  production: boolean;
  allowExplicitDemoBypass: boolean;
}

export function createConfiguredObjectStorage(config: AppConfig = getConfig()): ObjectStorage {
  if (config.storageProvider === "local") {
    return new LocalObjectStorage({
      root: path.resolve(config.storageDir, "objects"),
      defaultBucket: LOCAL_STORAGE_BUCKET,
      maxReadBytes: config.storageMaxObjectBytes
    });
  }
  if (!config.s3Endpoint || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
    throw new Error("S3 storage credentials and endpoint are required.");
  }
  return new S3ObjectStorage({
    client: new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey
      }
    }),
    bucket: config.s3Bucket,
    maxReadBytes: config.storageMaxObjectBytes,
    maxSignedUrlSeconds: config.storageSignedUrlTtlSeconds
  });
}

export function createConfiguredMalwareScanner(config: AppConfig = getConfig()): MalwareScanner {
  if (config.malwareScannerProvider === "clamav") {
    return new ClamAvScanner({
      host: config.clamavHost,
      port: config.clamavPort,
      timeoutMs: config.malwareScanTimeoutMs,
      maxBytes: config.malwareMaxFileBytes
    });
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("The mock malware scanner is unavailable in production.");
  }
  return new MockMalwareScanner();
}

export function createDocumentRuntime(config: AppConfig = getConfig()): DocumentRuntime {
  const production = process.env.NODE_ENV === "production";
  return {
    storage: createConfiguredObjectStorage(config),
    scanner: createConfiguredMalwareScanner(config),
    storageBucket: config.storageProvider === "s3" ? config.s3Bucket : LOCAL_STORAGE_BUCKET,
    maxUploadBytes: config.maxUploadBytes,
    maxObjectBytes: config.storageMaxObjectBytes,
    maxScanBytes: Math.min(config.storageMaxObjectBytes, config.malwareMaxFileBytes),
    production,
    allowExplicitDemoBypass:
      !production && config.demoMode && config.malwareAllowDemoBypass
  };
}

let runtime: DocumentRuntime | undefined;

export function getDocumentRuntime(): DocumentRuntime {
  runtime ??= createDocumentRuntime();
  return runtime;
}

export function resetDocumentRuntimeForTests(): void {
  runtime = undefined;
}
