import "dotenv/config";
import { getPool } from "../lib/db";

const tables = [
  "project_exports",
  "jobs",
  "ai_runs",
  "audit_events",
  "qa_findings",
  "deliverable_revisions",
  "deliverables",
  "finding_claims",
  "findings",
  "claim_evidence",
  "claims",
  "evidence",
  "sources",
  "research_plans",
  "research_questions",
  "research_projects",
  "clients",
  "workspaces"
];

async function resetDatabase(): Promise<void> {
  if (process.env.ALLOW_DATABASE_RESET !== "true") {
    throw new Error("Set ALLOW_DATABASE_RESET=true to reset application data.");
  }

  const pool = getPool();
  await pool.query("TRUNCATE TABLE " + tables.join(", ") + " RESTART IDENTITY CASCADE");
  await pool.end();
  process.stdout.write("Application tables reset.\n");
}

resetDatabase().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown reset error";
  process.stderr.write("Reset failed: " + message + "\n");
  process.exitCode = 1;
});
