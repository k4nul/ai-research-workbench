import { describe, expect, it, vi } from "vitest";

import type { GeneratedArtifact } from "@/lib/export/generate";
import { StorageError } from "@/lib/storage";
import {
  EXPORT_JOB_TYPE,
  ExportJobError,
  parseExportJob
} from "@/lib/services/export-jobs";
import type { JobRow } from "@/lib/services/jobs";
import { JobExecutionError } from "@/worker/durable-worker";
import {
  createExportJobHandler,
  exportExecutionError
} from "@/worker/export-handler";

const snapshot = {
  projectUpdatedAt: "2026-08-31 00:00:00+00",
  contentHash: "a".repeat(64),
  approvalStatus: "NOT_REQUESTED",
  qaPassedAt: null,
  approvedAt: null,
  deliverableId: "deliverable-fixture",
  deliverableUpdatedAt: "2026-08-31 00:00:00+00"
};

function exportJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "export-job-fixture",
    project_id: "project-fixture",
    job_type: EXPORT_JOB_TYPE,
    attempts: 2,
    input_reference: {
      projectId: "project-fixture",
      format: "PDF",
      requireApproval: false,
      snapshot,
      requestedBy: { actorType: "USER", actorLabel: "Trusted operator" }
    },
    ...overrides
  } as JobRow;
}

describe("durable export jobs", () => {
  it("validates the durable project linkage", () => {
    expect(parseExportJob(exportJob())).toMatchObject({
      projectId: "project-fixture",
      format: "PDF",
      snapshot: { contentHash: "a".repeat(64) }
    });
    expect(() =>
      parseExportJob(exportJob({ project_id: "other-project" }))
    ).toThrowError(ExportJobError);
    try {
      parseExportJob(exportJob({ project_id: "other-project" }));
    } catch (error) {
      expect(error).toMatchObject({ errorClass: "NON_RETRYABLE_SECURITY" });
    }
  });

  it("passes the frozen snapshot and lease fence without returning artifact bytes", async () => {
    const generated: GeneratedArtifact = {
      format: "PDF",
      filename: "final-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("synthetic-pdf"),
      persisted: {
        exportId: "export-fixture",
        inputHash: "b".repeat(64),
        sha256: "c".repeat(64),
        byteSize: 13
      }
    };
    const generate = vi.fn(async () => generated);
    const handler = createExportJobHandler({
      generate: generate as unknown as typeof import("@/lib/export/generate").generateArtifact
    });
    const controller = new AbortController();

    const result = await handler({
      job: exportJob(),
      workerId: "export-worker-fixture",
      signal: controller.signal
    });

    expect(generate).toHaveBeenCalledWith(
      "project-fixture",
      "PDF",
      expect.objectContaining({
        persist: true,
        expectedSnapshot: snapshot,
        signal: controller.signal,
        execution: expect.objectContaining({
          jobId: "export-job-fixture",
          workerId: "export-worker-fixture",
          attempt: 2,
          requestedBy: { actorType: "USER", actorLabel: "Trusted operator" }
        })
      })
    );
    expect(result).toMatchObject({
      exportId: "export-fixture",
      inputHash: "b".repeat(64),
      workerId: "export-worker-fixture",
      attempt: 2
    });
    expect(result).not.toHaveProperty("buffer");
  });

  it("classifies storage failures and preserves worker timeout cancellation", () => {
    expect(
      exportExecutionError(new StorageError("STORAGE_UNAVAILABLE", "Unavailable"))
    ).toMatchObject({ errorClass: "RETRYABLE_STORAGE" });

    const controller = new AbortController();
    const timeout = new JobExecutionError("Timed out", "RETRYABLE_TIMEOUT");
    controller.abort(timeout);
    expect(exportExecutionError(new Error("ignored"), controller.signal)).toBe(timeout);
  });
});
