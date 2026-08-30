import { getPool } from "@/lib/db";

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

export async function resetTestDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
    throw new Error("Refusing to reset a database without a test-like name.");
  }
  await getPool().query(
    "TRUNCATE TABLE " + tables.join(", ") + " RESTART IDENTITY CASCADE"
  );
}
