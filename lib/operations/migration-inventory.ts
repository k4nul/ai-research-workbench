import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type LocalMigration = {
  name: string;
  sql: string;
  checksum: string;
};

export type AppliedMigration = {
  name: string;
  checksum: string | null;
};

export type MigrationInventoryComparison = {
  matches: boolean;
  missing: string[];
  unexpected: string[];
  checksumMismatches: string[];
};

export async function loadLocalMigrations(
  migrationsDirectory = path.join(process.cwd(), "migrations")
): Promise<LocalMigration[]> {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    migrationFiles.map(async (name) => {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex")
      };
    })
  );
}

export function compareMigrationInventories(
  local: readonly Pick<LocalMigration, "name" | "checksum">[],
  applied: readonly AppliedMigration[]
): MigrationInventoryComparison {
  const localByName = new Map(local.map((migration) => [migration.name, migration]));
  const appliedByName = new Map(applied.map((migration) => [migration.name, migration]));
  const missing = local
    .filter((migration) => !appliedByName.has(migration.name))
    .map((migration) => migration.name);
  const unexpected = applied
    .filter((migration) => !localByName.has(migration.name))
    .map((migration) => migration.name)
    .sort();
  const checksumMismatches = local
    .filter((migration) => {
      const stored = appliedByName.get(migration.name)?.checksum;
      return stored !== undefined && stored !== migration.checksum;
    })
    .map((migration) => migration.name);
  return {
    matches:
      missing.length === 0 &&
      unexpected.length === 0 &&
      checksumMismatches.length === 0,
    missing,
    unexpected,
    checksumMismatches
  };
}
