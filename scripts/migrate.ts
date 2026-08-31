import "dotenv/config";
import path from "node:path";
import { getPool } from "../lib/db";
import { loadLocalMigrations } from "../lib/operations/migration-inventory";

async function migrate(): Promise<void> {
  const pool = getPool();
  const migrationsDirectory = path.join(process.cwd(), "migrations");
  const migrations = await loadLocalMigrations(migrationsDirectory);

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("SELECT pg_advisory_lock(735721)");
    lockAcquired = true;
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT)"
    );
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
    const applied = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name"
    );
    const localNames = new Set(migrations.map((migration) => migration.name));
    const unknownApplied = applied.rows
      .map((migration) => migration.name)
      .filter((name) => !localNames.has(name));
    if (unknownApplied.length > 0) {
      throw new Error(
        "Database contains migrations absent from this release: " +
          unknownApplied.join(", ") +
          ". Refusing to run an older schema contract."
      );
    }

    for (const { name, sql, checksum } of migrations) {
      const existing = await client.query<{ checksum: string | null }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum && existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${name} differs from its recorded checksum.`);
        }
        if (!existing.rows[0].checksum) {
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL",
            [name, checksum]
          );
        }
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum]
        );
        await client.query("COMMIT");
        process.stdout.write("Applied migration " + name + "\n");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (lockAcquired) await client.query("SELECT pg_advisory_unlock(735721)");
    } finally {
      client.release();
      await pool.end();
    }
  }
}

migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  process.stderr.write("Migration failed: " + message + "\n");
  process.exitCode = 1;
});
