import "dotenv/config";

import { defineConfig, devices } from "@playwright/test";

import { E2E_AUTH_STORAGE_STATE } from "./e2e/auth-fixture";
import { configureE2ETestDatabase } from "./e2e/database-safety";

const e2eDatabaseUrl = configureE2ETestDatabase();
const appUrl = process.env.APP_URL?.trim() || "https://127.0.0.1:3100";
const authSessionSecret =
  process.env.AUTH_SESSION_SECRET?.trim() ||
  "e2e-browser-session-secret-not-for-production";
const healthUrl = new URL("/api/health", appUrl).toString();

process.env.APP_URL = appUrl;
process.env.AUTH_SESSION_SECRET = authSessionSecret;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: appUrl,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: "npm run build && node --import tsx scripts/e2e-production-server.ts",
    env: {
      ...process.env,
      APP_BIND_HOST: "127.0.0.1",
      APP_URL: appUrl,
      AUTH_COOKIE_SECURE: "true",
      AUTH_DEMO_BYPASS: "false",
      AUTH_ENABLED: "true",
      AUTH_SESSION_SECRET: authSessionSecret,
      DATABASE_URL: e2eDatabaseUrl,
      CLAMAV_HOST: process.env.CLAMAV_HOST ?? "127.0.0.1",
      CLAMAV_PORT: process.env.CLAMAV_PORT ?? "53310",
      MALWARE_ALLOW_DEMO_BYPASS: "false",
      MALWARE_REQUIRED: "true",
      MALWARE_SCANNER_PROVIDER: "clamav",
      NODE_ENV: "production",
      TEST_DATABASE_URL: e2eDatabaseUrl
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    ignoreHTTPSErrors: true,
    url: healthUrl,
    reuseExistingServer: false,
    timeout: 180_000
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /auth\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: E2E_AUTH_STORAGE_STATE }
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], storageState: E2E_AUTH_STORAGE_STATE },
      testMatch: /mobile\.spec\.ts/
    },
    {
      name: "auth",
      testMatch: /auth\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: { cookies: [], origins: [] }
      }
    }
  ]
});
