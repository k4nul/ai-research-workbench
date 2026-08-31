import { describe, expect, it } from "vitest";
import { serializeStructuredLog } from "@/lib/observability/log";

describe("structured logging", () => {
  it("keeps bounded correlation fields and drops raw or secret-bearing details", () => {
    const serialized = serializeStructuredLog(
      "error",
      "job.failed",
      {
        service: "worker",
        workerId: "worker-1",
        jobId: "job-1",
        jobType: "RESEARCH_PIPELINE_STAGE",
        correlationId: "run-1",
        runId: "run-1",
        projectId: "project-1",
        stage: "draft_generation",
        errorCode: "NON_RETRYABLE_VALIDATION"
      },
      {
        status: "FAILED",
        count: 1,
        payload: "raw-document-content",
        token: "provider-secret"
      }
    );
    const record = JSON.parse(serialized) as Record<string, unknown>;

    expect(record).toMatchObject({
      level: "error",
      service: "worker",
      event: "job.failed",
      workerId: "worker-1",
      jobId: "job-1",
      jobType: "RESEARCH_PIPELINE_STAGE",
      correlationId: "run-1",
      runId: "run-1",
      projectId: "project-1",
      stage: "draft_generation",
      errorCode: "NON_RETRYABLE_VALIDATION",
      details: { status: "FAILED", count: 1 }
    });
    expect(serialized).not.toContain("raw-document-content");
    expect(serialized).not.toContain("provider-secret");
  });

  it("redacts credential-shaped correlation IDs and hashes other unsafe values", () => {
    const credential = JSON.parse(
      serializeStructuredLog("info", "request.received", {
        service: "web",
        requestId: "token:do-not-log"
      })
    ) as Record<string, unknown>;
    const untrusted = JSON.parse(
      serializeStructuredLog("info", "request.received", {
        service: "web",
        correlationId: "untrusted document content with spaces"
      })
    ) as Record<string, unknown>;

    expect(credential.requestId).toBe("redacted");
    expect(JSON.stringify(credential)).not.toContain("do-not-log");
    expect(untrusted.correlationId).toMatch(/^sha256:[a-f0-9]{24}$/);
    expect(JSON.stringify(untrusted)).not.toContain("untrusted document content");
  });
});
