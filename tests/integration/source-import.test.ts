import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "@/lib/db";
import { importSources } from "@/lib/services/ingestion";
import { createProject } from "@/lib/services/projects";
import { resetTestDatabase } from "@/tests/helpers/database";

function intake() {
  return {
    mode: "detailed",
    name: "Atomic source import fixture",
    clientName: "Synthetic import fixture",
    coreQuestion: "Does a batch source import commit only after every row validates?",
    background: "Synthetic integration fixture.",
    purpose: "Verify all-or-nothing source imports.",
    audience: "Test reviewer",
    scope: "Source import transaction behavior.",
    exclusions: "Real research data.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deliverableFormats: ["MARKDOWN"]
  };
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("source imports", () => {
  it("validates the full batch before committing any source or audit event", async () => {
    const project = await createProject(intake());

    await expect(
      importSources(project.id, {
        format: "json",
        content: JSON.stringify([
          {
            title: "Valid first source",
            url: "https://example.com/import-one",
            sourceType: "SYNTHETIC"
          },
          {
            title: "x",
            url: "https://example.com/import-invalid",
            sourceType: "SYNTHETIC"
          }
        ])
      })
    ).rejects.toBeTruthy();

    const afterRejectedBatch = await query<{ sources: number; audits: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM sources WHERE project_id = $1) AS sources,
         (SELECT COUNT(*)::integer FROM audit_events
            WHERE project_id = $1 AND action = 'SOURCE_ADDED') AS audits`,
      [project.id]
    );
    expect(afterRejectedBatch.rows[0]).toEqual({ sources: 0, audits: 0 });

    await expect(
      importSources(project.id, { format: "json", content: "[]" })
    ).rejects.toBeTruthy();
    await expect(
      importSources(project.id, { format: "json", content: "[{" })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_IMPORT_JSON" });
    await expect(
      query<{ sources: number }>(
        "SELECT COUNT(*)::integer AS sources FROM sources WHERE project_id = $1",
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ sources: 0 }] });

    const imported = await importSources(project.id, {
      format: "json",
      content: JSON.stringify([
        {
          title: "Valid first source",
          url: "https://example.com/import-one",
          sourceType: "SYNTHETIC"
        },
        {
          title: "Valid second source",
          url: "https://example.com/import-two",
          sourceType: "SYNTHETIC"
        }
      ])
    });

    expect(imported).toHaveLength(2);
    const afterAcceptedBatch = await query<{
      sources: number;
      audits: number;
      import_sources: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM sources WHERE project_id = $1) AS sources,
         (SELECT COUNT(*)::integer FROM audit_events
            WHERE project_id = $1 AND action = 'SOURCE_ADDED') AS audits,
         (SELECT COUNT(*)::integer FROM sources
            WHERE project_id = $1 AND ingestion_method = 'IMPORT') AS import_sources`,
      [project.id]
    );
    expect(afterAcceptedBatch.rows[0]).toEqual({
      sources: 2,
      audits: 2,
      import_sources: 2
    });
  });
});
