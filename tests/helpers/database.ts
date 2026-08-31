import { getPool } from "@/lib/db";

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

export async function resetTestDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
    throw new Error("Refusing to reset a database without a test-like name.");
  }
  await getPool().query(
    "TRUNCATE TABLE " + tables.join(", ") + " RESTART IDENTITY CASCADE"
  );
}
