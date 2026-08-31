import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const end = vi.fn();

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query, end })
}));

import { resetDatabase } from "../../scripts/reset-database";

const applicationTables = [
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

describe("database reset", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue(undefined);
    end.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ALLOW_DATABASE_RESET;
  });

  it("refuses to modify the database without the explicit reset opt-in", async () => {
    await expect(resetDatabase()).rejects.toThrow(
      "Set ALLOW_DATABASE_RESET=true to reset application data."
    );
    expect(query).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("truncates every application table and closes the pool", async () => {
    process.env.ALLOW_DATABASE_RESET = "true";

    await resetDatabase();

    expect(query).toHaveBeenCalledExactlyOnceWith(
      `TRUNCATE TABLE ${applicationTables.join(", ")} RESTART IDENTITY CASCADE`
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool when truncation fails", async () => {
    process.env.ALLOW_DATABASE_RESET = "true";
    query.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(resetDatabase()).rejects.toThrow("database unavailable");

    expect(end).toHaveBeenCalledOnce();
  });
});
