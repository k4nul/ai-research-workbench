import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET as auditRoute } from "@/app/api/audit/route";
import { GET as listJobsRoute } from "@/app/api/jobs/route";
import { POST as cancelJobRoute } from "@/app/api/jobs/[jobId]/cancel/route";
import { POST as retryJobRoute } from "@/app/api/jobs/[jobId]/retry/route";
import { POST as createRunRoute } from "@/app/api/runs/route";
import { POST as cancelRunRoute } from "@/app/api/runs/[runId]/cancel/route";
import { POST as resumeRunRoute } from "@/app/api/runs/[runId]/resume/route";
import { closePool, query } from "@/lib/db";
import { authenticateOperator, createOperator } from "@/lib/services/auth";
import { claimJobs, failJob, startJob, submitJob } from "@/lib/services/jobs";
import { approvePlan, approveScope, createProject } from "@/lib/services/projects";
import { addResearchPlan, addResearchQuestion } from "@/lib/services/workflow";

const origin = "http://localhost:3100";
const fixtureLabel = "Operations API fixture";
let approvedProjectId = "";
let otherProjectId = "";
let sessionCookie = "";
let csrfToken = "";
let expectedActorLabel = "";
const systemJobIds: string[] = [];

function intake(name: string) {
  return {
    mode: "detailed",
    name,
    clientName: fixtureLabel,
    coreQuestion: "Can protected operations preserve project-scoped durable state?",
    background: "Synthetic route integration fixture.",
    purpose: "Verify protected operations routes.",
    audience: "Test operator",
    scope: "Durable job and research run state.",
    exclusions: "Live provider calls.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN"],
    specialRequirements: "Synthetic fixtures only."
  };
}

async function createApprovedProject(): Promise<string> {
  const project = await createProject(intake(`Protected operations ${randomUUID()}`));
  await approveScope(project.id);
  const question = await addResearchQuestion(project.id, {
    question: "How does project scoping protect durable execution controls?",
    priority: "HIGH",
    completionCriteria: "Cross-project actions are rejected."
  });
  await addResearchPlan(project.id, {
    questionId: question.id,
    searchStrategy: "Use deterministic synthetic evidence.",
    searchQueries: ["protected operations fixture"],
    primarySourceTypes: ["SYNTHETIC"],
    secondarySourceTypes: [],
    comparisonTargets: ["project boundary"],
    expectedOutput: "A bounded execution trace.",
    completionCondition: "Every route preserves project scope.",
    expectedRisks: ["Cross-project mutation"],
    aiSuggested: false
  });
  await approvePlan(project.id);
  return project.id;
}

function authenticatedHeaders(idempotencyKey?: string): HeadersInit {
  return {
    cookie: `${sessionCookie}; arw_csrf=${encodeURIComponent(csrfToken)}`,
    origin,
    "x-csrf-token": csrfToken,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

function mutationRequest(path: string, projectId: string | null, key: string): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: authenticatedHeaders(key),
    body: JSON.stringify({ projectId })
  });
}

async function responseData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

beforeAll(async () => {
  vi.stubEnv("AUTH_DEMO_BYPASS", "false");
  vi.stubEnv("APP_URL", origin);
  const suffix = randomUUID().slice(0, 8);
  const operator = {
    username: `operations-api-${suffix}`,
    displayName: fixtureLabel,
    password: "correct protected operations fixture"
  };
  expectedActorLabel = `${operator.displayName} (${operator.username})`;
  await createOperator(operator);
  const session = await authenticateOperator({
    username: operator.username,
    password: operator.password,
    userAgent: "Operations API integration fixture",
    clientAddress: "127.0.0.1"
  });
  sessionCookie = `arw_session=${encodeURIComponent(session.sessionToken)}`;
  csrfToken = session.csrfToken;
  approvedProjectId = await createApprovedProject();
  otherProjectId = (await createProject(intake(`Other operations ${suffix}`))).id;
}, 30_000);

afterAll(async () => {
  try {
    if (systemJobIds.length > 0) {
      await query("DELETE FROM jobs WHERE id = ANY($1::text[])", [systemJobIds]);
    }
    if (approvedProjectId || otherProjectId) {
      await query("DELETE FROM research_projects WHERE id = ANY($1::text[])", [
        [approvedProjectId, otherProjectId].filter(Boolean)
      ]);
    }
    await query("DELETE FROM operators WHERE display_name = $1", [fixtureLabel]);
    await query("DELETE FROM audit_events WHERE actor_label = ANY($1::text[])", [
      [fixtureLabel, expectedActorLabel]
    ]);
  } finally {
    vi.unstubAllEnvs();
    await closePool();
  }
});

describe("protected operations routes", () => {
  it("rejects anonymous and forged sessions and requires CSRF", async () => {
    expect((await listJobsRoute(new Request(`${origin}/api/jobs`))).status).toBe(401);
    expect(
      (
        await listJobsRoute(
          new Request(`${origin}/api/jobs`, {
            headers: { cookie: "arw_session=forged-session-token" }
          })
        )
      ).status
    ).toBe(401);

    const job = await submitJob({
      projectId: approvedProjectId,
      jobType: `CSRF_FIXTURE_${randomUUID()}`,
      inputReference: { secretLikeInput: "must not be returned" },
      idempotencyKey: `csrf:${randomUUID()}`
    });
    const response = await cancelJobRoute(
      new Request(`${origin}/api/jobs/${job.job.id}/cancel`, {
        method: "POST",
        headers: { cookie: `${sessionCookie}; arw_csrf=${csrfToken}`, origin },
        body: JSON.stringify({ projectId: approvedProjectId })
      }),
      { params: Promise.resolve({ jobId: job.job.id }) }
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CSRF_INVALID" } });
  });

  it("lists safe job metadata and scopes idempotent cancel and retry actions", async () => {
    const cancelJob = await submitJob({
      projectId: approvedProjectId,
      jobType: `CANCEL_FIXTURE_${randomUUID()}`,
      inputReference: { privateInput: "omitted" },
      idempotencyKey: `cancel-job:${randomUUID()}`
    });
    const wrongProject = await cancelJobRoute(
      mutationRequest(`/api/jobs/${cancelJob.job.id}/cancel`, otherProjectId, "cancel-wrong-project"),
      { params: Promise.resolve({ jobId: cancelJob.job.id }) }
    );
    expect(wrongProject.status).toBe(404);

    const cancellationKey = `cancel:${randomUUID()}`;
    const cancelled = await cancelJobRoute(
      mutationRequest(`/api/jobs/${cancelJob.job.id}/cancel`, approvedProjectId, cancellationKey),
      { params: Promise.resolve({ jobId: cancelJob.job.id }) }
    );
    expect(cancelled.status).toBe(200);
    const cancelledData = await responseData<{ job: { status: string }; replayed: boolean }>(cancelled);
    expect(cancelledData).toMatchObject({
      job: { status: "CANCELLED" },
      replayed: false
    });
    const cancellationReplay = await cancelJobRoute(
      mutationRequest(`/api/jobs/${cancelJob.job.id}/cancel`, approvedProjectId, cancellationKey),
      { params: Promise.resolve({ jobId: cancelJob.job.id }) }
    );
    await expect(
      responseData<{ job: { status: string }; replayed: boolean }>(cancellationReplay)
    ).resolves.toEqual(cancelledData);

    const retryType = `RETRY_FIXTURE_${randomUUID()}`;
    const failedJob = await submitJob({
      projectId: approvedProjectId,
      jobType: retryType,
      inputReference: { privateInput: "omitted" },
      idempotencyKey: `failed-job:${randomUUID()}`,
      maxAttempts: 1
    });
    const claimed = (await claimJobs({
      workerId: "operations-api-worker",
      limit: 1,
      leaseDurationMs: 30_000,
      jobTypes: [retryType]
    }))[0];
    await startJob(claimed.id, "operations-api-worker", claimed.version);
    await failJob({
      jobId: failedJob.job.id,
      workerId: "operations-api-worker",
      errorClass: "NON_RETRYABLE_VALIDATION",
      error: new Error("Synthetic validation failure")
    });
    const retryKey = `retry:${randomUUID()}`;
    const retried = await retryJobRoute(
      mutationRequest(`/api/jobs/${failedJob.job.id}/retry`, approvedProjectId, retryKey),
      { params: Promise.resolve({ jobId: failedJob.job.id }) }
    );
    await expect(responseData<{ job: { status: string }; replayed: boolean }>(retried)).resolves.toMatchObject({
      job: { status: "QUEUED" },
      replayed: false
    });

    const listResponse = await listJobsRoute(
      new Request(`${origin}/api/jobs?projectId=${encodeURIComponent(approvedProjectId)}`, {
        headers: authenticatedHeaders()
      })
    );
    expect(listResponse.status).toBe(200);
    const serialized = JSON.stringify(await responseData<unknown[]>(listResponse));
    expect(serialized).not.toContain("input_reference");
    expect(serialized).not.toContain("privateInput");
    expect(serialized).not.toContain("payload");

    const auditResponse = await auditRoute(
      new Request(
        `${origin}/api/audit?projectId=${encodeURIComponent(approvedProjectId)}`,
        { headers: authenticatedHeaders() }
      )
    );
    expect(auditResponse.status).toBe(200);
    const auditEvents = await responseData<
      Array<{
        action: string;
        resource_id: string;
        actor_type: string;
        actor_label: string;
        after_state: Record<string, unknown>;
      }>
    >(auditResponse);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "JOB_CANCELLATION_REQUESTED",
          resource_id: cancelJob.job.id,
          actor_type: "USER",
          actor_label: expectedActorLabel,
          after_state: expect.objectContaining({ idempotencyKey: cancellationKey })
        }),
        expect.objectContaining({
          action: "JOB_MANUAL_RETRY",
          resource_id: failedJob.job.id,
          actor_type: "USER",
          actor_label: expectedActorLabel,
          after_state: expect.objectContaining({ idempotencyKey: retryKey })
        })
      ])
    );
    expect(
      auditEvents
        .filter((event) => [cancelJob.job.id, failedJob.job.id].includes(event.resource_id))
        .every((event) => !event.actor_label.includes(event.after_state.idempotencyKey as string))
    ).toBe(true);
  });

  it("allows operator recovery only for system-scoped storage cleanup jobs", async () => {
    const systemCleanup = await submitJob({
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, limit: 1_000, objectIds: [] },
      idempotencyKey: `system-cleanup-cancel:${randomUUID()}`
    });
    systemJobIds.push(systemCleanup.job.id);
    const wrongProjectScope = await cancelJobRoute(
      mutationRequest(
        `/api/jobs/${systemCleanup.job.id}/cancel`,
        approvedProjectId,
        `system-cleanup-project-scope:${randomUUID()}`
      ),
      { params: Promise.resolve({ jobId: systemCleanup.job.id }) }
    );
    expect(wrongProjectScope.status).toBe(404);

    const cancelled = await cancelJobRoute(
      mutationRequest(
        `/api/jobs/${systemCleanup.job.id}/cancel`,
        null,
        `system-cleanup-cancel-action:${randomUUID()}`
      ),
      { params: Promise.resolve({ jobId: systemCleanup.job.id }) }
    );
    expect(cancelled.status).toBe(200);
    await expect(
      responseData<{ job: { project_id: string | null; job_type: string; status: string } }>(
        cancelled
      )
    ).resolves.toMatchObject({
      job: { project_id: null, job_type: "STORAGE_CLEANUP", status: "CANCELLED" }
    });

    const projectCleanup = await submitJob({
      projectId: approvedProjectId,
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, limit: 1_000, objectIds: [] },
      idempotencyKey: `project-cleanup:${randomUUID()}`
    });
    const projectCleanupWithoutScope = await cancelJobRoute(
      mutationRequest(
        `/api/jobs/${projectCleanup.job.id}/cancel`,
        null,
        `project-cleanup-null-scope:${randomUUID()}`
      ),
      { params: Promise.resolve({ jobId: projectCleanup.job.id }) }
    );
    expect(projectCleanupWithoutScope.status).toBe(404);

    const otherSystemJob = await submitJob({
      jobType: `SYSTEM_FIXTURE_${randomUUID()}`,
      inputReference: {},
      idempotencyKey: `other-system-job:${randomUUID()}`
    });
    systemJobIds.push(otherSystemJob.job.id);
    const otherSystemCancellation = await cancelJobRoute(
      mutationRequest(
        `/api/jobs/${otherSystemJob.job.id}/cancel`,
        null,
        `other-system-cancel:${randomUUID()}`
      ),
      { params: Promise.resolve({ jobId: otherSystemJob.job.id }) }
    );
    expect(otherSystemCancellation.status).toBe(404);

    const failedCleanup = await submitJob({
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, limit: 1_000, objectIds: [] },
      idempotencyKey: `system-cleanup-retry:${randomUUID()}`
    });
    systemJobIds.push(failedCleanup.job.id);
    await query(
      `UPDATE jobs SET status = 'FAILED', completed_at = NOW(),
        error_class = 'NON_RETRYABLE_VALIDATION', sanitized_error = 'Synthetic cleanup failure.',
        updated_at = NOW(), version = version + 1
       WHERE id = $1`,
      [failedCleanup.job.id]
    );
    const retried = await retryJobRoute(
      mutationRequest(
        `/api/jobs/${failedCleanup.job.id}/retry`,
        null,
        `system-cleanup-retry-action:${randomUUID()}`
      ),
      { params: Promise.resolve({ jobId: failedCleanup.job.id }) }
    );
    expect(retried.status).toBe(200);
    await expect(
      responseData<{ job: { project_id: string | null; job_type: string; status: string } }>(
        retried
      )
    ).resolves.toMatchObject({
      job: { project_id: null, job_type: "STORAGE_CLEANUP", status: "QUEUED" }
    });

    const missingScope = await cancelJobRoute(
      new Request(`${origin}/api/jobs/${otherSystemJob.job.id}/cancel`, {
        method: "POST",
        headers: authenticatedHeaders(`missing-job-scope:${randomUUID()}`),
        body: JSON.stringify({})
      }),
      { params: Promise.resolve({ jobId: otherSystemJob.job.id }) }
    );
    expect(missingScope.status).toBe(400);
  });

  it("creates, cancels, and resumes a safe idempotent research run", async () => {
    const createKey = `run:${randomUUID()}`;
    const createRequest = () =>
      new Request(`${origin}/api/runs`, {
        method: "POST",
        headers: authenticatedHeaders(createKey),
        body: JSON.stringify({ projectId: approvedProjectId, mode: "ORCHESTRATED" })
      });
    const createdResponse = await createRunRoute(createRequest());
    expect(createdResponse.status).toBe(201);
    const created = await responseData<{
      run: { id: string; status: string };
      created: boolean;
    }>(createdResponse);
    expect(created).toMatchObject({ created: true, run: { status: "QUEUED" } });
    expect(JSON.stringify(created)).not.toContain("input_reference");
    expect(JSON.stringify(created)).not.toContain("provider_config_snapshot");

    const replay = await responseData<typeof created>(
      await createRunRoute(createRequest())
    );
    expect(replay).toEqual(created);

    const cancelKey = `cancel-run:${randomUUID()}`;
    const cancelled = await cancelRunRoute(
      mutationRequest(`/api/runs/${created.run.id}/cancel`, approvedProjectId, cancelKey),
      { params: Promise.resolve({ runId: created.run.id }) }
    );
    await expect(responseData<{ run: { status: string } }>(cancelled)).resolves.toMatchObject({
      run: { status: "CANCELLED" }
    });

    const resumeKey = `resume-run:${randomUUID()}`;
    const resumed = await resumeRunRoute(
      mutationRequest(`/api/runs/${created.run.id}/resume`, approvedProjectId, resumeKey),
      { params: Promise.resolve({ runId: created.run.id }) }
    );
    const resumedData = await responseData<{
      detail: { run: { status: string } };
      replayed: boolean;
    }>(resumed);
    expect(resumedData).toMatchObject({
      detail: { run: { status: "QUEUED" } },
      replayed: false
    });
    const resumedReplay = await resumeRunRoute(
      mutationRequest(`/api/runs/${created.run.id}/resume`, approvedProjectId, resumeKey),
      { params: Promise.resolve({ runId: created.run.id }) }
    );
    await expect(
      responseData<{ detail: { run: { status: string } }; replayed: boolean }>(resumedReplay)
    ).resolves.toEqual(resumedData);

    const auditResponse = await auditRoute(
      new Request(
        `${origin}/api/audit?projectId=${encodeURIComponent(approvedProjectId)}`,
        { headers: authenticatedHeaders() }
      )
    );
    const auditEvents = await responseData<
      Array<{
        action: string;
        resource_id: string;
        actor_type: string;
        actor_label: string;
        after_state: Record<string, unknown>;
      }>
    >(auditResponse);
    const runEvents = auditEvents.filter(
      (event) => event.resource_id === created.run.id
    );
    expect(runEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "RESEARCH_RUN_CREATED",
          actor_type: "USER",
          actor_label: expectedActorLabel,
          after_state: expect.objectContaining({ idempotencyKey: createKey })
        }),
        expect.objectContaining({
          action: "RESEARCH_RUN_CANCELLATION_REQUESTED",
          actor_type: "USER",
          actor_label: expectedActorLabel,
          after_state: expect.objectContaining({ idempotencyKey: cancelKey })
        }),
        expect.objectContaining({
          action: "RESEARCH_RUN_RESUMED",
          actor_type: "USER",
          actor_label: expectedActorLabel,
          after_state: expect.objectContaining({ idempotencyKey: resumeKey })
        })
      ])
    );
    expect(
      runEvents.every(
        (event) => !event.actor_label.includes(event.after_state.idempotencyKey as string)
      )
    ).toBe(true);
  });
});
