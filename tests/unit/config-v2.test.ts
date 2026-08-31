import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigForTests } from "@/lib/config";

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigForTests();
});

describe("v0.2 runtime configuration", () => {
  it("exposes bounded worker, storage, scanner, and auth defaults", () => {
    const config = getConfig();
    expect(config.jobLeaseDurationMs).toBeGreaterThan(
      config.jobHeartbeatIntervalMs * 2
    );
    expect(config.storageProvider).toBe("local");
    expect(config.malwareRequired).toBe(true);
    expect(config.authEnabled).toBe(true);
    expect(config.s3SecretAccessKey).toBeUndefined();
  });

  it("rejects a heartbeat that cannot safely renew the lease", () => {
    vi.stubEnv("JOB_HEARTBEAT_INTERVAL_MS", "5000");
    vi.stubEnv("JOB_LEASE_DURATION_MS", "10000");
    resetConfigForTests();
    expect(() => getConfig()).toThrow(
      "JOB_LEASE_DURATION_MS must exceed twice JOB_HEARTBEAT_INTERVAL_MS"
    );
  });

  it("requires S3 credentials when the S3 provider is selected", () => {
    vi.stubEnv("STORAGE_PROVIDER", "s3");
    vi.stubEnv("S3_ENDPOINT", "http://127.0.0.1:9000");
    vi.stubEnv("S3_ACCESS_KEY_ID", "");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
    resetConfigForTests();
    expect(() => getConfig()).toThrow();
  });

  it("rejects insecure production runtime configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("npm_lifecycle_event", "start");
    vi.stubEnv("AUTH_ENABLED", "false");
    vi.stubEnv("AUTH_COOKIE_SECURE", "false");
    vi.stubEnv("MALWARE_SCANNER_PROVIDER", "mock");
    resetConfigForTests();
    expect(() => getConfig()).toThrow("Production requires authentication");
  });
});
