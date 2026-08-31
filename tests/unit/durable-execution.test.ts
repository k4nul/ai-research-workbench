import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_RETRY_POLICY,
  InvalidJobTransitionError,
  assertJobTransition,
  calculateRetryDelayMs,
  failureJobStatus,
  sanitizeJobError
} from "@/lib/domain/jobs";
import {
  assertResearchRunTransition,
  assertRunStageTransition
} from "@/lib/domain/research-runs";
import {
  PIPELINE_STAGE_CATALOG,
  validatePipelineStageCatalog
} from "@/lib/execution/stages";
import { AI_STAGES } from "@/lib/providers";
import {
  JOB_INPUT_MAX_BYTES,
  serializeJobReference
} from "@/lib/services/jobs";
import { AppError } from "@/lib/services/errors";
import {
  DurableWorker,
  JobExecutionError,
  classifyJobExecutionError
} from "@/worker/durable-worker";

describe("durable job state rules", () => {
  it("allows only declared state transitions", () => {
    expect(() => assertJobTransition("QUEUED", "CLAIMED")).not.toThrow();
    expect(() => assertJobTransition("RUNNING", "SUCCEEDED")).not.toThrow();
    expect(() => assertJobTransition("FAILED", "QUEUED")).not.toThrow();
    expect(() => assertJobTransition("SUCCEEDED", "RUNNING")).toThrow(
      InvalidJobTransitionError
    );
    expect(() => assertJobTransition("QUEUED", "SUCCEEDED")).toThrow(
      "Job cannot transition from QUEUED to SUCCEEDED."
    );
  });

  it("uses bounded exponential backoff, deterministic jitter, and Retry-After", () => {
    expect(
      calculateRetryDelayMs({
        attempt: 1,
        policy: DEFAULT_JOB_RETRY_POLICY,
        random: () => 0.5
      })
    ).toBe(1_000);
    expect(
      calculateRetryDelayMs({
        attempt: 4,
        policy: DEFAULT_JOB_RETRY_POLICY,
        random: () => 0.5
      })
    ).toBe(8_000);
    expect(
      calculateRetryDelayMs({
        attempt: 20,
        policy: DEFAULT_JOB_RETRY_POLICY,
        random: () => 0.5
      })
    ).toBe(60_000);
    expect(
      calculateRetryDelayMs({
        attempt: 1,
        policy: DEFAULT_JOB_RETRY_POLICY,
        retryAfterMs: 120_000,
        random: () => 0
      })
    ).toBe(120_000);
  });

  it("retries only bounded retryable failures and dead-letters exhausted jobs", () => {
    expect(
      failureJobStatus({
        errorClass: "RETRYABLE_NETWORK",
        attempts: 1,
        maxAttempts: 2
      })
    ).toBe("RETRY_WAIT");
    expect(
      failureJobStatus({
        errorClass: "RETRYABLE_NETWORK",
        attempts: 2,
        maxAttempts: 2
      })
    ).toBe("DEAD_LETTER");
    expect(
      failureJobStatus({
        errorClass: "NON_RETRYABLE_SECURITY",
        attempts: 1,
        maxAttempts: 3
      })
    ).toBe("FAILED");
  });

  it("redacts common credentials and bounds persisted errors", () => {
    const sanitized = sanitizeJobError(
      "Bearer abc.def token=top-secret password:hunter2\ninternal detail"
    );
    expect(sanitized).not.toContain("abc.def");
    expect(sanitized).not.toContain("top-secret");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized.length).toBeLessThanOrEqual(2_000);
  });

  it("bounds job references by UTF-8 bytes and distinguishes input from output errors", () => {
    const characterCount = Math.floor(JOB_INPUT_MAX_BYTES / 4);
    expect(() =>
      serializeJobReference({ text: "a".repeat(characterCount) }, "input")
    ).not.toThrow();

    try {
      serializeJobReference({ text: "😀".repeat(characterCount) }, "input");
      throw new Error("Expected the multibyte input to exceed the byte limit.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        status: 413,
        code: "JOB_INPUT_TOO_LARGE",
        details: {
          maximumBytes: JOB_INPUT_MAX_BYTES
        }
      });
    }

    expect(() => serializeJobReference(1n, "output")).toThrow(
      expect.objectContaining({
        status: 400,
        code: "INVALID_JOB_OUTPUT"
      })
    );
  });

  it("classifies invalid persisted output as non-retryable validation", () => {
    expect(
      classifyJobExecutionError(
        new AppError(413, "JOB_OUTPUT_TOO_LARGE", "Synthetic bounded output.")
      )
    ).toBe("NON_RETRYABLE_VALIDATION");
    expect(
      classifyJobExecutionError(
        new JobExecutionError("Synthetic timeout.", "RETRYABLE_TIMEOUT")
      )
    ).toBe("RETRYABLE_TIMEOUT");
    expect(classifyJobExecutionError(new Error("Synthetic unknown."))).toBe(
      "UNKNOWN"
    );
  });

  it("normalizes registered job-type capacity within global worker capacity", () => {
    const worker = new DurableWorker(
      new Map([["DOCUMENT_EXTRACT", async () => ({})]]),
      {
        concurrency: 2,
        jobTypeConcurrency: { DOCUMENT_EXTRACT: 8 }
      }
    );
    expect(worker.configuredJobTypeConcurrency("DOCUMENT_EXTRACT")).toBe(2);
    expect(() =>
      new DurableWorker(
        new Map([["DOCUMENT_EXTRACT", async () => ({})]]),
        { jobTypeConcurrency: { MISSPELLED_EXTRACT: 1 } }
      )
    ).toThrow(/unregistered job type/);
  });

  it("bounds and normalizes an optional worker run allowlist", () => {
    expect(
      () =>
        new DurableWorker(new Map([["NOOP", async () => ({})]]), {
          runIds: ["same-run", " same-run "]
        })
    ).toThrow("runIds must not contain duplicates.");
    expect(
      () =>
        new DurableWorker(new Map([["NOOP", async () => ({})]]), {
          runIds: Array.from({ length: 1_001 }, (_, index) => `run-${index}`)
        })
    ).toThrow("runIds must contain at most 1000 entries.");
    expect(
      () =>
        new DurableWorker(new Map([["NOOP", async () => ({})]]), {
          runIds: [" "]
        })
    ).toThrow("Each runId must contain 1-500 characters.");
  });
});

describe("research execution state and stage catalog", () => {
  it("uses every existing AI stage exactly once in dependency order", () => {
    expect(PIPELINE_STAGE_CATALOG.map((stage) => stage.id)).toEqual(AI_STAGES);
    expect(PIPELINE_STAGE_CATALOG.map((stage) => stage.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ]);
    expect(() => validatePipelineStageCatalog()).not.toThrow();
    for (const stage of PIPELINE_STAGE_CATALOG) {
      for (const dependency of stage.dependencies) {
        const dependencyOrdinal = PIPELINE_STAGE_CATALOG.find(
          (candidate) => candidate.id === dependency
        )?.ordinal;
        expect(dependencyOrdinal).toBeLessThan(stage.ordinal);
      }
    }
  });

  it("guards run and stage transitions independently", () => {
    expect(() => assertResearchRunTransition("QUEUED", "RUNNING")).not.toThrow();
    expect(() => assertResearchRunTransition("COMPLETED", "RUNNING")).toThrow();
    expect(() => assertRunStageTransition("RUNNING", "SUCCEEDED")).not.toThrow();
    expect(() => assertRunStageTransition("SUCCEEDED", "RUNNING")).toThrow();
    expect(() => assertRunStageTransition("SUCCEEDED", "STALE")).not.toThrow();
  });
});
