import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as searchSourcesRoute } from "@/app/api/projects/[projectId]/sources/search/route";
import { DEFAULT_RUN_BUDGET } from "@/lib/budgets";
import { closePool, query } from "@/lib/db";
import {
  MockSearchProvider,
  ProviderRequestError,
  type SearchProvider
} from "@/lib/providers";
import {
  claimJobs,
  completeJob,
  getJob,
  recoverExpiredJobs,
  startJob,
  type JobRow
} from "@/lib/services/jobs";
import { approvePlan, approveScope, createProject } from "@/lib/services/projects";
import { createResearchRun } from "@/lib/services/research-runs";
import {
  SOURCE_SEARCH_JOB,
  submitSourceSearchJob
} from "@/lib/services/source-search-jobs";
import { addResearchPlan, addResearchQuestion } from "@/lib/services/workflow";
import { resetTestDatabase } from "@/tests/helpers/database";
import { DurableWorker } from "@/worker/durable-worker";
import { createSourceSearchHandler } from "@/worker/source-search-handler";

const origin = "http://localhost:3100";
const actor = {
  actorType: "USER" as const,
  actorLabel: "Durable source-search integration fixture"
};
const permitPolicy = {
  requestLimit: 100,
  windowSeconds: 60,
  concurrencyLimit: 4,
  permitTtlMs: 5_000
};

function intake(name: string) {
  return {
    mode: "detailed" as const,
    name,
    clientName: "Durable source-search fixture client",
    coreQuestion: "Can durable search collect synthetic material idempotently?",
    background: "Synthetic integration fixture.",
    purpose: "Exercise durable source search.",
    audience: "Test reviewer",
    scope: "Synthetic provider results only.",
    exclusions: "Live provider traffic.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN"] as const,
    specialRequirements: "Fixture data only."
  };
}

async function createApprovedProject(name: string): Promise<string> {
  const project = await createProject(intake(name));
  await approveScope(project.id);
  const question = await addResearchQuestion(project.id, {
    question: "Which durable-search invariant is exercised by this fixture?",
    priority: "HIGH",
    completionCriteria: "The durable source effect is bounded and idempotent."
  });
  await addResearchPlan(project.id, {
    questionId: question.id,
    searchStrategy: "Use deterministic mock provider results.",
    searchQueries: ["synthetic durable search evidence"],
    primarySourceTypes: ["SYNTHETIC"],
    secondarySourceTypes: [],
    comparisonTargets: ["durable retry"],
    expectedOutput: "A project-scoped source set.",
    completionCondition: "Search provenance and source IDs are durable.",
    expectedRisks: ["Duplicate effects"],
    aiSuggested: false
  });
  await approvePlan(project.id);
  return project.id;
}

async function createRun(
  name: string,
  budget: typeof DEFAULT_RUN_BUDGET = DEFAULT_RUN_BUDGET
) {
  const projectId = await createApprovedProject(name);
  const created = await createResearchRun({
    projectId,
    mode: "ORCHESTRATED",
    idempotencyKey: `run-${randomUUID()}`,
    createdBy: actor.actorLabel,
    searchConfigSnapshot: { searchProvider: "mock-search" },
    budget: { ...budget }
  });
  return { projectId, runId: created.run.id };
}

function worker(provider?: SearchProvider): DurableWorker {
  return new DurableWorker(
    new Map([
      [
        SOURCE_SEARCH_JOB,
        createSourceSearchHandler({
          ...(provider ? { providerForJob: () => provider } : {}),
          permitPolicy
        })
      ]
    ]),
    {
      workerId: `search-worker-${randomUUID()}`,
      concurrency: 1,
      pollIntervalMs: 10,
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      shutdownGraceMs: 2_000,
      log: () => undefined
    }
  );
}

async function executeAttempt(
  durableWorker: DurableWorker,
  jobId: string
): Promise<JobRow> {
  expect(await durableWorker.runOnce()).toBe(1);
  for (let attempt = 0; attempt < 200 && durableWorker.activeJobCount > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(durableWorker.activeJobCount).toBe(0);
  return getJob(jobId);
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("durable source search", () => {
  it("keeps the legacy API asynchronous and idempotent", async () => {
    const projectId = (await createProject(intake("Legacy durable search API"))).id;
    const context = { params: Promise.resolve({ projectId }) };
    const request = () =>
      new Request(`${origin}/api/projects/${projectId}/sources/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "idempotency-key": "legacy-search-stable-1",
          "x-forwarded-for": `source-search-${projectId}`
        },
        body: JSON.stringify({ query: "synthetic evidence", count: 2 })
      });

    const first = await searchSourcesRoute(request(), context);
    const second = await searchSourcesRoute(request(), context);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { data: Record<string, unknown> };
    const secondBody = (await second.json()) as { data: Record<string, unknown> };
    expect(firstBody.data).toMatchObject({
      search: null,
      registered: [],
      created: true,
      queued: true,
      job: { jobType: SOURCE_SEARCH_JOB, status: "QUEUED" }
    });
    expect(secondBody).toEqual(firstBody);
    expect(
      (await query("SELECT id FROM jobs WHERE project_id = $1 AND job_type = $2", [
        projectId,
        SOURCE_SEARCH_JOB
      ])).rowCount
    ).toBe(1);
    expect(
      (await query("SELECT id FROM sources WHERE project_id = $1", [projectId])).rowCount
    ).toBe(0);
  });

  it.each([
    {
      label: "search-request",
      budget: { ...DEFAULT_RUN_BUDGET, maxSearchRequests: 0 },
      expected: "MAX_SEARCH_REQUESTS"
    },
    {
      label: "source",
      budget: { ...DEFAULT_RUN_BUDGET, maxSources: 0 },
      expected: "MAX_SOURCES"
    }
  ])("stops before the provider call when the run $label budget is exhausted", async ({
    label,
    budget,
    expected
  }) => {
    const { projectId, runId } = await createRun(`Budget stop ${label}`, budget);
    const search = await submitSourceSearchJob({
      projectId,
      rawInput: {
        runId,
        query: "synthetic evidence",
        count: 1,
        idempotencyKey: `budget-${label}-stable`
      },
      actor
    });
    const mock = new MockSearchProvider();
    const provider: SearchProvider = {
      id: mock.id,
      isConfigured: () => true,
      search: vi.fn((request) => mock.search(request))
    };
    const completed = await executeAttempt(worker(provider), search.job.id);
    expect(completed).toMatchObject({
      status: "FAILED",
      error_class: "NON_RETRYABLE_BUDGET"
    });
    expect(completed.sanitized_error).toContain(expected);
    expect(provider.search).not.toHaveBeenCalled();
    const usage = await query<{
      status: string;
      total_search_requests: number;
    }>(
      "SELECT status, total_search_requests FROM research_runs WHERE id = $1",
      [runId]
    );
    expect(usage.rows[0].status).toBe("BLOCKED");
    expect(usage.rows[0].total_search_requests).toBe(0);
    expect(
      (await query("SELECT id FROM provider_executions WHERE job_id = $1", [
        search.job.id
      ])).rowCount
    ).toBe(0);
  });

  it("retries provider errors with provenance and then succeeds", async () => {
    const { projectId, runId } = await createRun("Retryable durable search");
    const search = await submitSourceSearchJob({
      projectId,
      rawInput: {
        runId,
        query: "synthetic evidence",
        count: 1,
        idempotencyKey: "retryable-search-stable"
      },
      actor
    });
    const mock = new MockSearchProvider();
    let calls = 0;
    const provider: SearchProvider = {
      id: mock.id,
      isConfigured: () => true,
      search: vi.fn(async (request) => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderRequestError("Synthetic search rate limit", {
            classification: "RETRYABLE_PROVIDER_RATE_LIMIT",
            retryable: true,
            retryAfterMs: 1
          });
        }
        return mock.search(request);
      })
    };
    const durableWorker = worker(provider);
    const first = await executeAttempt(durableWorker, search.job.id);
    expect(first).toMatchObject({
      status: "RETRY_WAIT",
      error_class: "RETRYABLE_PROVIDER_RATE_LIMIT"
    });
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [search.job.id]);
    const second = await executeAttempt(durableWorker, search.job.id);
    expect(second.status).toBe("SUCCEEDED");
    expect(provider.search).toHaveBeenCalledTimes(2);
    const executions = await query<{ status: string; error_class: string | null }>(
      "SELECT status, error_class FROM provider_executions WHERE job_id = $1 ORDER BY started_at",
      [search.job.id]
    );
    expect(executions.rows).toEqual([
      { status: "FAILED", error_class: "RETRYABLE_PROVIDER_RATE_LIMIT" },
      { status: "SUCCEEDED", error_class: null }
    ]);
    expect(
      (
        await query<{ total_search_requests: number }>(
          "SELECT total_search_requests FROM research_runs WHERE id = $1",
          [runId]
        )
      ).rows[0].total_search_requests
    ).toBe(2);
  });

  it("does not duplicate project sources when a committed attempt is reclaimed", async () => {
    const { projectId, runId } = await createRun("At-least-once durable search");
    const submission = await submitSourceSearchJob({
      projectId,
      rawInput: {
        runId,
        query: "sample",
        count: 2,
        idempotencyKey: "at-least-once-search"
      },
      actor
    });
    const handler = createSourceSearchHandler({ permitPolicy });
    const claimedA = (
      await claimJobs({
        workerId: "search-worker-a",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: [SOURCE_SEARCH_JOB]
      })
    )[0];
    const runningA = await startJob(claimedA.id, "search-worker-a", claimedA.version);
    const outputA = (await handler({
      job: runningA,
      workerId: "search-worker-a",
      signal: new AbortController().signal
    })) as { registered: { id: string }[] };
    await query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [submission.job.id]
    );
    await recoverExpiredJobs({ random: () => 0 });
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [submission.job.id]);
    const claimedB = (
      await claimJobs({
        workerId: "search-worker-b",
        limit: 1,
        leaseDurationMs: 5_000,
        jobTypes: [SOURCE_SEARCH_JOB]
      })
    )[0];
    const runningB = await startJob(claimedB.id, "search-worker-b", claimedB.version);
    const outputB = (await handler({
      job: runningB,
      workerId: "search-worker-b",
      signal: new AbortController().signal
    })) as { registered: { id: string }[] };
    await completeJob({
      jobId: runningB.id,
      workerId: "search-worker-b",
      outputReference: outputB
    });

    expect(outputB.registered.map((source) => source.id).sort()).toEqual(
      outputA.registered.map((source) => source.id).sort()
    );
    const sources = await query<{ id: string; project_id: string }>(
      "SELECT id, project_id FROM sources WHERE project_id = $1 ORDER BY id",
      [projectId]
    );
    expect(sources.rowCount).toBe(2);
    expect(new Set(sources.rows.map((row) => row.id)).size).toBe(2);
    expect(sources.rows.every((row) => row.project_id === projectId)).toBe(true);
    expect(
      (
        await query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM audit_events WHERE project_id = $1 AND action = 'SOURCE_ADDED'",
          [projectId]
        )
      ).rows[0].count
    ).toBe(2);
    expect(
      (
        await query<{ total_search_requests: number }>(
          "SELECT total_search_requests FROM research_runs WHERE id = $1",
          [runId]
        )
      ).rows[0].total_search_requests
    ).toBe(1);
    expect(
      (
        await query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM provider_executions WHERE job_id = $1",
          [submission.job.id]
        )
      ).rows[0].count
    ).toBe(1);

    const otherProjectId = (
      await createProject(intake("Project-scoped durable search IDs"))
    ).id;
    const otherSubmission = await submitSourceSearchJob({
      projectId: otherProjectId,
      rawInput: {
        query: "sample",
        count: 2,
        idempotencyKey: "other-project-search"
      },
      actor
    });
    expect(
      (await executeAttempt(worker(), otherSubmission.job.id)).status
    ).toBe("SUCCEEDED");
    const otherSources = await query<{ id: string }>(
      "SELECT id FROM sources WHERE project_id = $1 ORDER BY id",
      [otherProjectId]
    );
    expect(otherSources.rowCount).toBe(2);
    expect(
      otherSources.rows.every(
        (source) => !sources.rows.some((original) => original.id === source.id)
      )
    ).toBe(true);
  });
});
