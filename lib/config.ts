import { z } from "zod";

const optionalNonBlank = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().default("postgresql://research:research@localhost:55432/research_workbench"),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(2).max(100).default(10),
  DEMO_MODE: z.enum(["true", "false"]).default("true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3100"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(25_000_000).default(5_242_880),
  MAX_FETCH_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_097_152),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  JOB_LEASE_DURATION_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  JOB_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  PROVIDER_REQUEST_LIMIT: z.coerce.number().int().min(1).max(100_000).default(60),
  PROVIDER_REQUEST_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
  DOCUMENT_EXTRACTION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().min(1).default("./.data"),
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().min(1).max(100).default("us-east-1"),
  S3_BUCKET: z.string().min(3).max(63).default("research-workbench"),
  S3_ACCESS_KEY_ID: optionalNonBlank,
  S3_SECRET_ACCESS_KEY: optionalNonBlank,
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  STORAGE_MAX_OBJECT_BYTES: z.coerce.number().int().min(1_024).max(100_000_000).default(25_000_000),
  MALWARE_SCANNER_PROVIDER: z.enum(["clamav", "mock"]).default("mock"),
  CLAMAV_HOST: z.string().min(1).max(255).default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  MALWARE_SCAN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  MALWARE_MAX_FILE_BYTES: z.coerce.number().int().min(1_024).max(100_000_000).default(25_000_000),
  MALWARE_REQUIRED: z.enum(["true", "false"]).default("true"),
  MALWARE_ALLOW_DEMO_BYPASS: z.enum(["true", "false"]).default("false"),
  AUTH_ENABLED: z.enum(["true", "false"]).default("true"),
  AUTH_SESSION_SECRET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32).optional()
  ),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(43_200),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  AUTH_DEMO_BYPASS: z.enum(["true", "false"]).default("false"),
  MODEL_PRICING_JSON: optionalNonBlank
});

export type AppConfig = {
  databaseUrl: string;
  databasePoolSize: number;
  demoMode: boolean;
  openAiApiKey?: string;
  openAiModel: string;
  braveSearchApiKey?: string;
  appUrl: string;
  maxUploadBytes: number;
  maxFetchBytes: number;
  fetchTimeoutMs: number;
  storageDir: string;
  workerConcurrency: number;
  workerPollIntervalMs: number;
  jobLeaseDurationMs: number;
  jobHeartbeatIntervalMs: number;
  jobDefaultTimeoutMs: number;
  jobMaxAttempts: number;
  providerConcurrency: number;
  providerRequestLimit: number;
  providerRequestWindowSeconds: number;
  documentExtractionConcurrency: number;
  storageProvider: "local" | "s3";
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
  storageSignedUrlTtlSeconds: number;
  storageMaxObjectBytes: number;
  malwareScannerProvider: "clamav" | "mock";
  clamavHost: string;
  clamavPort: number;
  malwareScanTimeoutMs: number;
  malwareMaxFileBytes: number;
  malwareRequired: boolean;
  malwareAllowDemoBypass: boolean;
  authEnabled: boolean;
  authSessionSecret?: string;
  authSessionTtlSeconds: number;
  authCookieSecure: boolean;
  authDemoBypass: boolean;
  modelPricingJson?: string;
};

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = environmentSchema.parse(process.env);
  if (parsed.JOB_HEARTBEAT_INTERVAL_MS * 2 >= parsed.JOB_LEASE_DURATION_MS) {
    throw new Error("JOB_LEASE_DURATION_MS must exceed twice JOB_HEARTBEAT_INTERVAL_MS");
  }
  if (
    parsed.STORAGE_PROVIDER === "s3" &&
    (!parsed.S3_ENDPOINT || !parsed.S3_ACCESS_KEY_ID || !parsed.S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      "S3_ENDPOINT, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required for s3 storage"
    );
  }
  const production = process.env.NODE_ENV === "production";
  const productionBuild =
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build";
  const authCookieSecure = parsed.AUTH_COOKIE_SECURE
    ? parsed.AUTH_COOKIE_SECURE === "true"
    : production;
  if (production && !productionBuild) {
    if (parsed.AUTH_ENABLED !== "true" || parsed.AUTH_DEMO_BYPASS === "true") {
      throw new Error("Production requires authentication with no demo bypass");
    }
    if (!authCookieSecure || !parsed.AUTH_SESSION_SECRET) {
      throw new Error("Production requires secure auth cookies and AUTH_SESSION_SECRET");
    }
    if (
      parsed.MALWARE_REQUIRED !== "true" ||
      parsed.MALWARE_SCANNER_PROVIDER !== "clamav" ||
      parsed.MALWARE_ALLOW_DEMO_BYPASS === "true"
    ) {
      throw new Error("Production requires fail-closed ClamAV scanning");
    }
  }
  const appUrl = new URL(parsed.APP_URL);
  if (
    parsed.AUTH_DEMO_BYPASS === "true" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname)
  ) {
    throw new Error("AUTH_DEMO_BYPASS is restricted to a loopback APP_URL");
  }
  cachedConfig = {
    databaseUrl: parsed.DATABASE_URL,
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    demoMode: parsed.DEMO_MODE === "true",
    openAiApiKey: parsed.OPENAI_API_KEY || undefined,
    openAiModel: parsed.OPENAI_MODEL,
    braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY || undefined,
    appUrl: parsed.APP_URL,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxFetchBytes: parsed.MAX_FETCH_BYTES,
    fetchTimeoutMs: parsed.FETCH_TIMEOUT_MS,
    storageDir: parsed.STORAGE_DIR,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    workerPollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    jobLeaseDurationMs: parsed.JOB_LEASE_DURATION_MS,
    jobHeartbeatIntervalMs: parsed.JOB_HEARTBEAT_INTERVAL_MS,
    jobDefaultTimeoutMs: parsed.JOB_DEFAULT_TIMEOUT_MS,
    jobMaxAttempts: parsed.JOB_MAX_ATTEMPTS,
    providerConcurrency: parsed.PROVIDER_CONCURRENCY,
    providerRequestLimit: parsed.PROVIDER_REQUEST_LIMIT,
    providerRequestWindowSeconds: parsed.PROVIDER_REQUEST_WINDOW_SECONDS,
    documentExtractionConcurrency: parsed.DOCUMENT_EXTRACTION_CONCURRENCY,
    storageProvider: parsed.STORAGE_PROVIDER,
    s3Endpoint: parsed.S3_ENDPOINT,
    s3Region: parsed.S3_REGION,
    s3Bucket: parsed.S3_BUCKET,
    s3AccessKeyId: parsed.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: parsed.S3_FORCE_PATH_STYLE === "true",
    storageSignedUrlTtlSeconds: parsed.STORAGE_SIGNED_URL_TTL_SECONDS,
    storageMaxObjectBytes: parsed.STORAGE_MAX_OBJECT_BYTES,
    malwareScannerProvider: parsed.MALWARE_SCANNER_PROVIDER,
    clamavHost: parsed.CLAMAV_HOST,
    clamavPort: parsed.CLAMAV_PORT,
    malwareScanTimeoutMs: parsed.MALWARE_SCAN_TIMEOUT_MS,
    malwareMaxFileBytes: parsed.MALWARE_MAX_FILE_BYTES,
    malwareRequired: parsed.MALWARE_REQUIRED === "true",
    malwareAllowDemoBypass: parsed.MALWARE_ALLOW_DEMO_BYPASS === "true",
    authEnabled: parsed.AUTH_ENABLED === "true",
    authSessionSecret: parsed.AUTH_SESSION_SECRET,
    authSessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
    authCookieSecure,
    authDemoBypass: parsed.AUTH_DEMO_BYPASS === "true",
    modelPricingJson: parsed.MODEL_PRICING_JSON
  };
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}

export function maskSecret(value: string | undefined): string {
  if (!value) {
    return "not configured";
  }
  if (value.length < 8) {
    return "••••";
  }
  return value.slice(0, 3) + "••••" + value.slice(-3);
}
