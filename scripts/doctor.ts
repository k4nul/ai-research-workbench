import "dotenv/config";
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { getConfig, maskSecret } from "../lib/config";
import { getPool } from "../lib/db";

const execFileAsync = promisify(execFile);

type Check = {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
};

async function doctor(): Promise<void> {
  const config = getConfig();
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    status: major >= 22 ? "ok" : "error",
    detail: process.version + (major >= 22 ? "" : " (Node 22+ required)")
  });

  try {
    const { stdout } = await execFileAsync("docker", ["--version"], { timeout: 5_000 });
    checks.push({ name: "Docker", status: "ok", detail: stdout.trim() });
  } catch {
    checks.push({
      name: "Docker",
      status: "warning",
      detail: "Not available; a separately managed PostgreSQL instance can be used."
    });
  }

  try {
    const pool = getPool();
    const result = await pool.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version"
    );
    checks.push({
      name: "PostgreSQL",
      status: "ok",
      detail: "Connected to PostgreSQL " + result.rows[0].version
    });
    await pool.end();
  } catch {
    checks.push({
      name: "PostgreSQL",
      status: "error",
      detail: "Connection failed. Run npm run db:start and npm run db:migrate."
    });
  }

  const browserPath = chromium.executablePath();
  try {
    await access(browserPath);
    checks.push({ name: "Playwright Chromium", status: "ok", detail: browserPath });
  } catch {
    checks.push({
      name: "Playwright Chromium",
      status: "warning",
      detail: "Not installed. Run npx playwright install chromium."
    });
  }

  try {
    const storageDirectory = path.resolve(config.storageDir);
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    const probe = path.join(storageDirectory, ".doctor-write-probe");
    await writeFile(probe, "ok", { mode: 0o600 });
    await unlink(probe);
    checks.push({ name: "Storage", status: "ok", detail: storageDirectory });
  } catch {
    checks.push({
      name: "Storage",
      status: "error",
      detail: "Configured storage directory is not writable."
    });
  }

  checks.push({
    name: "AI provider",
    status: config.openAiApiKey ? "ok" : "warning",
    detail: config.openAiApiKey
      ? "OpenAI key " + maskSecret(config.openAiApiKey)
      : "Mock provider active; no API key is required."
  });
  checks.push({
    name: "Search provider",
    status: config.braveSearchApiKey ? "ok" : "warning",
    detail: config.braveSearchApiKey
      ? "Brave key " + maskSecret(config.braveSearchApiKey)
      : "Mock provider active; no API key is required."
  });

  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    process.stdout.write(
      check.status.toUpperCase().padEnd(7) +
        " " +
        check.name.padEnd(width) +
        "  " +
        check.detail +
        "\n"
    );
  }
  if (checks.some((check) => check.status === "error")) {
    process.exitCode = 1;
  }
}

doctor().catch((error: unknown) => {
  process.stderr.write(
    "Doctor failed: " + (error instanceof Error ? error.message : "Unknown error") + "\n"
  );
  process.exitCode = 1;
});
