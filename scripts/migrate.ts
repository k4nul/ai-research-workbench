import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "../lib/db";

async function migrate(): Promise<void> {
  const pool = getPool();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  );

  const migrationsDirectory = path.join(process.cwd(), "migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of migrationFiles) {
    const existing = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [name]
    );
    if (existing.rowCount) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(735721)");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [name]
      );
      await client.query("COMMIT");
      process.stdout.write("Applied migration " + name + "\n");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  process.stderr.write("Migration failed: " + message + "\n");
  process.exitCode = 1;
});
