import "dotenv/config";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

async function prepareTestDatabase(): Promise<void> {
  const primaryUrl =
    process.env.DATABASE_URL ??
    "postgresql://research:research@localhost:55432/research_workbench";
  const testUrl =
    process.env.TEST_DATABASE_URL ??
    "postgresql://research:research@localhost:55432/research_workbench_test";
  const parsedTestUrl = new URL(testUrl);
  const databaseName = parsedTestUrl.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName) || !databaseName.toLowerCase().includes("test")) {
    throw new Error("TEST_DATABASE_URL must name an explicit test database.");
  }

  const adminUrl = new URL(primaryUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName]
    );
    if (!existing.rowCount) {
      await client.query('CREATE DATABASE "' + databaseName + '"');
      process.stdout.write("Created test database " + databaseName + ".\n");
    }
  } finally {
    await client.end();
  }

  const executable = path.resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );
  const result = await execFileAsync(executable, ["scripts/migrate.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl },
    timeout: 30_000
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
}

prepareTestDatabase().catch((error: unknown) => {
  process.stderr.write(
    "Test database preparation failed: " +
      (error instanceof Error ? error.message : "Unknown error") +
      "\n"
  );
  process.exitCode = 1;
});
