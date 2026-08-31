import "dotenv/config";
import { pathToFileURL } from "node:url";

import { closePool } from "../lib/db";
import { getConfig } from "../lib/config";
import { getDocumentRuntime } from "../lib/documents/runtime";
import {
  cleanupOrphanObjects,
  PostgresStorageObjectCatalog
} from "../lib/services/orphan-cleanup";

export const CLEANUP_ORPHANS_HELP = `Usage: npm run cleanup:orphans -- [options]

Options:
  --delete-untracked       Delete grace-aged objects absent from the catalog.
  --grace-ms=<number>      Minimum untracked-object age (default: 3600000).
  --lease-seconds=<number> Tracked-deletion lease duration (default: 60).
  --limit=<number>         Maximum objects per reconciliation page (default: 100).
  --help, -h               Show this help.

Safety: stop all artifact writers and workers before using --delete-untracked;
its catalog comparison is a point-in-time reconciliation.
`;

export const UNTRACKED_DELETION_WARNING =
  "WARNING: --delete-untracked uses a point-in-time catalog comparison; " +
  "all artifact writers and workers must be quiesced before use.\n";

export function cleanupOrphanCliNotice(
  args: readonly string[]
): { kind: "help" | "warning" | "none"; message?: string } {
  if (args.includes("--help") || args.includes("-h")) {
    return { kind: "help", message: CLEANUP_ORPHANS_HELP };
  }
  if (args.includes("--delete-untracked")) {
    return { kind: "warning", message: UNTRACKED_DELETION_WARNING };
  }
  return { kind: "none" };
}

function integerArgument(name: string, fallback: number, args: readonly string[]): number {
  const prefix = `--${name}=`;
  const raw = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function main(args: readonly string[]): Promise<void> {
  const notice = cleanupOrphanCliNotice(args);
  if (notice.kind === "help") {
    process.stdout.write(notice.message ?? CLEANUP_ORPHANS_HELP);
    return;
  }
  if (notice.kind === "warning") {
    process.stderr.write(notice.message ?? UNTRACKED_DELETION_WARNING);
  }
  const runtime = getDocumentRuntime();
  const deleteUntracked = args.includes("--delete-untracked");
  const result = await cleanupOrphanObjects({
    storage: runtime.storage,
    catalog: new PostgresStorageObjectCatalog(),
    bucket: runtime.storageBucket,
    legacyStorageRoot: getConfig().storageDir,
    graceMs: integerArgument("grace-ms", 60 * 60 * 1_000, args),
    leaseSeconds: integerArgument("lease-seconds", 60, args),
    limit: integerArgument("limit", 100, args),
    deleteUntracked
  });
  process.stdout.write(
    `${JSON.stringify({
      status:
        result.failedTracked.length === 0 && result.remainingTrackedCount === 0
          ? "PASSED"
          : "WARNING",
      deleteUntracked,
      deletedTracked: result.deletedTrackedIds.length,
      failedTracked: result.failedTracked.length,
      remainingTracked: result.remainingTrackedCount,
      deletedUntracked: result.deletedUntrackedCount,
      skippedRecentUntracked: result.skippedRecentUntrackedCount
    })}\n`
  );
  if (result.failedTracked.length > 0 || result.remainingTrackedCount > 0) {
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.argv.slice(2))
    .catch((error: unknown) => {
      process.stderr.write(
        `Orphan cleanup failed: ${error instanceof Error ? error.message : "Unknown error"}\n`
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
