import "dotenv/config";
import { pathToFileURL } from "node:url";
import { getPool } from "../lib/db";

const tables = [
  "mutation_receipts",
  "evaluation_runs",
  "provider_canary_runs",
  "provider_permits",
  "provider_rate_windows",
  "provider_executions",
  "worker_heartbeats",
  "operator_sessions",
  "operator_login_rate_limits",
  "operators",
  "citation_anchors",
  "document_chunks",
  "document_blocks",
  "document_extractions",
  "document_scan_results",
  "documents",
  "project_exports",
  "storage_objects",
  "stage_domain_commits",
  "job_events",
  "job_attempts",
  "research_run_stages",
  "research_runs",
  "approval_revisions",
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

export async function resetDatabase(): Promise<void> {
  if (process.env.ALLOW_DATABASE_RESET !== "true") {
    throw new Error("Set ALLOW_DATABASE_RESET=true to reset application data.");
  }

  const pool = getPool();
  try {
    await pool.query("TRUNCATE TABLE " + tables.join(", ") + " RESTART IDENTITY CASCADE");
  } finally {
    await pool.end();
  }
  process.stdout.write("Application tables reset.\n");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  resetDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown reset error";
    process.stderr.write("Reset failed: " + message + "\n");
    process.exitCode = 1;
  });
}
