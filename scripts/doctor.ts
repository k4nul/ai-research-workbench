import "dotenv/config";

import { access, mkdir, open, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig, maskSecret } from "../lib/config";
import { closePool, getPool } from "../lib/db";
import {
  compareMigrationInventories,
  loadLocalMigrations
} from "../lib/operations/migration-inventory";

const execFileAsync = promisify(execFile);

type CheckStatus =
  | "PASS"
  | "WARNING"
  | "FAIL"
  | "OPTIONAL_MISSING"
  | "NOT_CONFIGURED";

type Check = { name: string; status: CheckStatus; detail: string };

function nodeVersionSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

async function doctor(): Promise<void> {
  const config = getConfig();
  const checks: Check[] = [];
  checks.push({
    name: "Node.js",
    status: nodeVersionSupported() ? "PASS" : "FAIL",
    detail: `${process.version}${nodeVersionSupported() ? "" : " (Node 22.13+ required)"}`
  });

  try {
    const { stdout } = await execFileAsync("docker", ["--version"], { timeout: 5_000 });
    checks.push({ name: "Docker", status: "PASS", detail: stdout.trim() });
  } catch {
    checks.push({
      name: "Docker",
      status: "OPTIONAL_MISSING",
      detail: "Install Docker for the supported Compose environment."
    });
  }

  try {
    const pool = getPool();
    const localMigrations = await loadLocalMigrations();
    const [versionResult, appliedResult] = await Promise.all([
      pool.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version"
      ),
      pool.query<{ name: string; checksum: string | null }>(
        "SELECT name, checksum FROM schema_migrations ORDER BY name"
      )
    ]);
    const inventory = compareMigrationInventories(localMigrations, appliedResult.rows);
    const mismatchDetails = [
      inventory.missing.length > 0 ? `missing ${inventory.missing.join(", ")}` : null,
      inventory.unexpected.length > 0
        ? `unexpected ${inventory.unexpected.join(", ")}`
        : null,
      inventory.checksumMismatches.length > 0
        ? `checksum mismatch ${inventory.checksumMismatches.join(", ")}`
        : null
    ].filter(Boolean);
    checks.push({
      name: "PostgreSQL",
      status: inventory.matches ? "PASS" : "FAIL",
      detail:
        `PostgreSQL ${versionResult.rows[0].version}; ` +
        `${appliedResult.rows.length}/${localMigrations.length} exact migrations` +
        (mismatchDetails.length > 0 ? `; ${mismatchDetails.join("; ")}` : "")
    });
  } catch {
    checks.push({
      name: "PostgreSQL",
      status: "FAIL",
      detail: "Connection or schema check failed; run npm run setup."
    });
  } finally {
    await closePool().catch(() => undefined);
  }

  try {
    const { chromium } = await import("@playwright/test");
    await access(chromium.executablePath());
    checks.push({
      name: "Playwright Chromium",
      status: "PASS",
      detail: chromium.executablePath()
    });
  } catch {
    checks.push({
      name: "Playwright Chromium",
      status: "OPTIONAL_MISSING",
      detail: "Run npx playwright install chromium before browser verification."
    });
  }

  if (config.storageProvider === "local") {
    try {
      const storageDirectory = path.resolve(config.storageDir);
      await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
      const probe = path.join(storageDirectory, `.doctor-write-probe-${process.pid}`);
      const handle = await open(probe, "wx", 0o600);
      await handle.writeFile("ok");
      await handle.close();
      await unlink(probe);
      checks.push({ name: "Object storage", status: "PASS", detail: storageDirectory });
    } catch {
      checks.push({
        name: "Object storage",
        status: "FAIL",
        detail: "Configured private local storage is not safely writable."
      });
    }
  } else {
    checks.push({
      name: "Object storage",
      status: "WARNING",
      detail: `S3-compatible endpoint configured; access key ${maskSecret(config.s3AccessKeyId)} (run integration health to verify connectivity).`
    });
  }

  checks.push({
    name: "Malware scanner",
    status: "WARNING",
    detail:
      config.malwareScannerProvider === "clamav"
        ? `ClamAV configured at ${config.clamavHost}:${config.clamavPort}; worker readiness verifies connectivity.`
        : "Mock scanner configured; this is permitted only for local/demo fixtures."
  });
  checks.push({
    name: "Operator auth",
    status: config.authEnabled && Boolean(config.authSessionSecret) ? "PASS" : "WARNING",
    detail: config.authEnabled
      ? `Enabled; session secret ${maskSecret(config.authSessionSecret)}; secure cookie ${config.authCookieSecure}.`
      : "Disabled; never expose this process to an untrusted network."
  });
  checks.push({
    name: "Auth bypass",
    status: config.authDemoBypass ? "WARNING" : "PASS",
    detail: config.authDemoBypass
      ? "Explicit loopback-only demo bypass is active."
      : "Disabled."
  });
  checks.push({
    name: "OpenAI provider",
    status: config.openAiApiKey ? "PASS" : "NOT_CONFIGURED",
    detail: config.openAiApiKey
      ? `Credential ${maskSecret(config.openAiApiKey)}; model ${config.openAiModel}.`
      : "Deterministic mock AI remains available."
  });
  checks.push({
    name: "Brave provider",
    status: config.braveSearchApiKey ? "PASS" : "NOT_CONFIGURED",
    detail: config.braveSearchApiKey
      ? `Credential ${maskSecret(config.braveSearchApiKey)}.`
      : "Deterministic mock search remains available."
  });

  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    process.stdout.write(
      `${check.status.padEnd(16)} ${check.name.padEnd(width)}  ${check.detail}\n`
    );
  }
  if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1;
}

doctor().catch((error: unknown) => {
  process.stderr.write(
    `Doctor failed: ${error instanceof Error ? error.message : "Unknown error"}\n`
  );
  process.exitCode = 1;
});
