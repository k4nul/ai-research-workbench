import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET as downloadExportRoute,
  POST as submitExportRoute
} from "@/app/api/projects/[projectId]/exports/[format]/route";
import { resetConfigForTests } from "@/lib/config";
import { resetDocumentRuntimeForTests } from "@/lib/documents/runtime";
import { closePool, query } from "@/lib/db";
import { loadExportData } from "@/lib/export/generate";
import { authenticateOperator, createOperator } from "@/lib/services/auth";
import {
  EXPORT_JOB_TYPE,
  submitProjectExportJob
} from "@/lib/services/export-jobs";
import { persistExportArtifact } from "@/lib/services/export-storage";
import {
  getJob,
  requestJobCancellation,
  type JobRow
} from "@/lib/services/jobs";
import {
  LocalObjectStorage,
  type ObjectStorage,
  type PutObjectInput,
  type StoredObject
} from "@/lib/storage";
import { createProject } from "@/lib/services/projects";
import { resetTestDatabase } from "@/tests/helpers/database";
import { DurableWorker, JobExecutionError } from "@/worker/durable-worker";
import { createExportJobHandler } from "@/worker/export-handler";

const origin = "http://localhost:3100";
const temporaryDirectories: string[] = [];

function intake(name: string) {
  return {
    mode: "detailed" as const,
    name,
    clientName: "Durable export fixture client",
    coreQuestion: "Can durable exports survive retries and cancellation safely?",
    background: "Synthetic durable export integration fixture.",
    purpose: "Verify idempotent export jobs.",
    audience: "Test reviewer",
    scope: "Synthetic project data only.",
    exclusions: "Customer data and live providers.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "ZIP"] as const,
    specialRequirements: "No external calls."
  };
}

function routeContext(projectId: string, format: string) {
  return { params: Promise.resolve({ projectId, format }) };
}

async function localRuntime(): Promise<{
  storage: LocalObjectStorage;
  bucket: string;
  maxObjectBytes: number;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "research-export-job-"));
  temporaryDirectories.push(root);
  return {
    storage: new LocalObjectStorage({
      root,
      defaultBucket: "private",
      maxReadBytes: 1_000_000
    }),
    bucket: "private",
    maxObjectBytes: 1_000_000
  };
}

function worker(
  handler: ReturnType<typeof createExportJobHandler>,
  suffix: string
): DurableWorker {
  return new DurableWorker(new Map([[EXPORT_JOB_TYPE, handler]]), {
    workerId: `export-worker-${suffix}`,
    concurrency: 1,
    pollIntervalMs: 10,
    leaseDurationMs: 2_000,
    heartbeatIntervalMs: 100,
    shutdownGraceMs: 2_000,
    log: () => undefined
  });
}

async function waitForIdle(
  durableWorker: DurableWorker,
  jobId: string,
  expectedStatuses: readonly string[]
): Promise<JobRow> {
  let current = await getJob(jobId);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (durableWorker.activeJobCount === 0 && expectedStatuses.includes(current.status)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await getJob(jobId);
  }
  throw new Error(`Export job did not become idle (last status: ${current.status}).`);
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for export storage.")),
      2_000
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

beforeEach(async () => {
  vi.stubEnv("AUTH_DEMO_BYPASS", "false");
  vi.stubEnv("APP_URL", origin);
  resetConfigForTests();
  resetDocumentRuntimeForTests();
  await resetTestDatabase();
});

afterEach(async () => {
  resetDocumentRuntimeForTests();
  resetConfigForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

afterAll(async () => {
  await closePool();
});

describe("durable export API and worker", () => {
  it("exports only current claims, evidence, and QA findings", async () => {
    const project = await createProject(intake("Current export snapshot"));
    const runtime = await localRuntime();
    const sourceId = `source-${project.id}`;
    const currentEvidenceId = `current-evidence-${project.id}`;
    const staleEvidenceId = `stale-evidence-${project.id}`;
    const currentClaimId = `current-claim-${project.id}`;
    const detachedClaimId = `detached-claim-${project.id}`;
    const staleClaimId = `stale-claim-${project.id}`;
    const deliverable = await query<{ id: string }>(
      "SELECT id FROM deliverables WHERE project_id = $1",
      [project.id]
    );
    await query(
      "UPDATE research_projects SET approval_status = 'APPROVED', approved_at = NOW(), qa_passed_at = NOW() WHERE id = $1",
      [project.id]
    );
    await query(
      `INSERT INTO sources (id, project_id, title, source_type)
       VALUES ($1, $2, 'Synthetic current-source fixture', 'OTHER')`,
      [sourceId, project.id]
    );
    await query(
      `INSERT INTO evidence (
         id, source_id, summary, verification_status, is_current
       ) VALUES
         ($1, $3, 'Current evidence fixture.', 'VERIFIED', TRUE),
         ($2, $3, 'Stale evidence fixture.', 'VERIFIED', FALSE)`,
      [currentEvidenceId, staleEvidenceId, sourceId]
    );
    await query(
      `INSERT INTO claims (
         id, project_id, content, claim_type, support_status, is_current
       ) VALUES
         ($1, $4, 'Current claim with current evidence.', 'FACT', 'SUPPORTED', TRUE),
         ($2, $4, 'Current claim with only stale evidence.', 'FACT', 'SUPPORTED', TRUE),
         ($3, $4, 'Superseded generated claim.', 'FACT', 'SUPPORTED', FALSE)`,
      [currentClaimId, detachedClaimId, staleClaimId, project.id]
    );
    await query(
      `INSERT INTO claim_evidence (claim_id, evidence_id, relationship)
       VALUES ($1, $3, 'SUPPORTS'), ($2, $4, 'SUPPORTS')`,
      [currentClaimId, detachedClaimId, currentEvidenceId, staleEvidenceId]
    );
    await query(
      `INSERT INTO qa_findings (
         id, project_id, deliverable_id, rule_code, severity, location,
         problem, remediation, resolution_status, is_current
       ) VALUES
         ($1, $3, $4, 'STALE_BLOCKER_FIXTURE', 'BLOCKER', 'stale:fixture',
          'Superseded blocker.', 'No action.', 'OPEN', FALSE),
         ($2, $3, $4, 'CURRENT_NOTE_FIXTURE', 'LOW', 'current:fixture',
          'Current review note.', 'Review note.', 'OPEN', TRUE)`,
      [
        `stale-qa-${project.id}`,
        `current-qa-${project.id}`,
        project.id,
        deliverable.rows[0].id
      ]
    );

    const data = await loadExportData(project.id, true);
    expect(data.claims.map((claim) => claim.id)).toEqual([
      currentClaimId,
      detachedClaimId
    ].sort());
    expect(
      data.claims.find((claim) => claim.id === currentClaimId)?.linked_evidence
    ).toEqual([expect.objectContaining({ evidenceId: currentEvidenceId })]);
    expect(
      data.claims.find((claim) => claim.id === detachedClaimId)?.linked_evidence
    ).toEqual([]);
    expect(data.qaFindings).toEqual([
      expect.objectContaining({ rule_code: "CURRENT_NOTE_FIXTURE" })
    ]);

    await expect(
      persistExportArtifact({
        projectId: project.id,
        snapshot: data.snapshot,
        artifact: {
          format: "MARKDOWN",
          filename: "final-report.md",
          mimeType: "text/markdown; charset=utf-8",
          buffer: Buffer.from("# Current-only synthetic export\n")
        },
        requireApproval: true,
        runtime,
        durationMs: 1
      })
    ).resolves.toMatchObject({ exportId: expect.any(String) });
  });

  it("protects POST submission, preserves GET downloads, and replays one trusted request", async () => {
    const project = await createProject(intake("Protected durable export"));
    const username = `export-operator-${randomUUID().slice(0, 8)}`;
    const displayName = "Durable export operator";
    await createOperator({
      username,
      displayName,
      password: "correct durable export fixture password"
    });
    const session = await authenticateOperator({
      username,
      password: "correct durable export fixture password",
      userAgent: "Durable export API fixture",
      clientAddress: "127.0.0.1"
    });
    const cookie = `arw_session=${encodeURIComponent(session.sessionToken)}; arw_csrf=${encodeURIComponent(session.csrfToken)}`;
    const context = routeContext(project.id, "markdown");

    const anonymous = await submitExportRoute(
      new Request(`${origin}/api/projects/${project.id}/exports/markdown`, {
        method: "POST",
        headers: { origin, "idempotency-key": "export-anonymous" }
      }),
      context
    );
    expect(anonymous.status).toBe(401);

    const missingCsrf = await submitExportRoute(
      new Request(`${origin}/api/projects/${project.id}/exports/markdown`, {
        method: "POST",
        headers: { origin, cookie, "idempotency-key": "export-missing-csrf" }
      }),
      context
    );
    expect(missingCsrf.status).toBe(403);

    const idempotencyKey = `export:${randomUUID()}`;
    const request = () =>
      new Request(`${origin}/api/projects/${project.id}/exports/markdown`, {
        method: "POST",
        headers: {
          origin,
          cookie,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": idempotencyKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actorType: "SYSTEM",
          actorLabel: "Forged HTTP actor"
        })
      });
    const first = await submitExportRoute(request(), context);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      data: { job: { id: string; status: string; format: string }; created: boolean };
    };
    expect(firstBody.data).toMatchObject({
      job: { status: "QUEUED", format: "MARKDOWN" },
      created: true
    });

    await query(
      "UPDATE research_projects SET name = name || ' revised', updated_at = NOW() + INTERVAL '1 second' WHERE id = $1",
      [project.id]
    );
    const replay = await submitExportRoute(request(), context);
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual(firstBody);

    const actorLabel = `${displayName} (${username})`;
    await expect(
      query<{
        actor_label: string;
        requested_by: Record<string, unknown>;
        jobs: number;
      }>(
        `SELECT a.actor_label,
          j.input_reference->'requestedBy' AS requested_by,
          COUNT(DISTINCT j.id)::integer AS jobs
         FROM jobs j
         JOIN audit_events a ON a.resource_id = j.id AND a.action = 'EXPORT_QUEUED'
         WHERE j.id = $1
         GROUP BY j.id, a.actor_label, j.input_reference->'requestedBy'`,
        [firstBody.data.job.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          actor_label: actorLabel,
          requested_by: { actorType: "USER", actorLabel },
          jobs: 1
        }
      ]
    });

    const download = await downloadExportRoute(
      new Request(`${origin}/api/projects/${project.id}/exports/markdown`, {
        headers: { cookie }
      }),
      context
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("final-report.md");
    expect(await download.text()).toContain("# Protected durable export");

    const legacyPersist = await downloadExportRoute(
      new Request(`${origin}/api/projects/${project.id}/exports/markdown?persist=true`, {
        headers: { cookie }
      }),
      context
    );
    expect(legacyPersist.status).toBe(405);
    await expect(legacyPersist.json()).resolves.toMatchObject({
      error: { code: "EXPORT_PERSIST_POST_REQUIRED" }
    });
    expect(
      (
        await query(
          "SELECT id FROM project_exports WHERE project_id = $1",
          [project.id]
        )
      ).rowCount
    ).toBe(0);
  });

  it("reuses one persisted effect when a worker loses its first completion response", async () => {
    const project = await createProject(intake("At-least-once durable export"));
    const runtime = await localRuntime();
    const submitted = await submitProjectExportJob({
      projectId: project.id,
      format: "MARKDOWN",
      idempotencyKey: `retry-${randomUUID()}`,
      actor: { actorType: "USER", actorLabel: "Retry fixture operator" }
    });
    const base = createExportJobHandler({ runtime });
    let loseFirstResponse = true;
    const faultInjected = worker(async (context) => {
      const output = await base(context);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new JobExecutionError(
          "Synthetic response loss after export persistence.",
          "RETRYABLE_STORAGE"
        );
      }
      return output;
    }, "retry");

    expect(await faultInjected.runOnce()).toBe(1);
    const retryWait = await waitForIdle(faultInjected, submitted.job.id, ["RETRY_WAIT"]);
    expect(retryWait.attempts).toBe(1);
    await query("UPDATE jobs SET scheduled_at = NOW() WHERE id = $1", [submitted.job.id]);
    expect(await faultInjected.runOnce()).toBe(1);
    const succeeded = await waitForIdle(faultInjected, submitted.job.id, ["SUCCEEDED"]);
    expect(succeeded.attempts).toBe(2);
    expect(succeeded.output_reference).toMatchObject({
      projectId: project.id,
      format: "MARKDOWN",
      requestedBy: { actorType: "USER", actorLabel: "Retry fixture operator" }
    });
    expect(succeeded.output_reference).not.toHaveProperty("buffer");

    await expect(
      query<{ exports: number; objects: number; generated_audits: number }>(
        `SELECT
          COUNT(DISTINCT pe.id)::integer AS exports,
          COUNT(DISTINCT so.id)::integer AS objects,
          COUNT(DISTINCT a.id)::integer AS generated_audits
         FROM project_exports pe
         JOIN storage_objects so ON so.id = pe.storage_object_id
         LEFT JOIN audit_events a ON a.resource_id = pe.id AND a.action = 'EXPORT_GENERATED'
         WHERE pe.project_id = $1`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ exports: 1, objects: 1, generated_audits: 1 }]
    });
  });

  it("does not finalize an uploaded object after cancellation and safely recovers it on new work", async () => {
    const project = await createProject(intake("Cancelled durable export"));
    const runtime = await localRuntime();
    let announcePut!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      announcePut = resolve;
    });
    const putMayReturn = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const blockingStorage: ObjectStorage = {
      provider: runtime.storage.provider,
      put: async (input: PutObjectInput): Promise<StoredObject> => {
        const stored = await runtime.storage.put(input);
        announcePut();
        await putMayReturn;
        return stored;
      },
      read: runtime.storage.read.bind(runtime.storage),
      head: runtime.storage.head.bind(runtime.storage),
      delete: runtime.storage.delete.bind(runtime.storage),
      list: runtime.storage.list.bind(runtime.storage),
      createDownloadUrl: runtime.storage.createDownloadUrl.bind(runtime.storage)
    };
    const submitted = await submitProjectExportJob({
      projectId: project.id,
      format: "MARKDOWN",
      idempotencyKey: `cancel-${randomUUID()}`,
      actor: { actorType: "USER", actorLabel: "Cancellation fixture operator" }
    });
    const durableWorker = worker(
      createExportJobHandler({ runtime: { ...runtime, storage: blockingStorage } }),
      "cancel"
    );

    expect(await durableWorker.runOnce()).toBe(1);
    await withTimeout(putStarted);
    await requestJobCancellation(submitted.job.id, "Cancellation fixture operator");
    releasePut();
    const cancelled = await waitForIdle(durableWorker, submitted.job.id, ["CANCELLED"]);
    expect(cancelled.error_class).toBe("CANCELLED");

    await expect(
      query<{
        persistence_status: string;
        is_current: boolean;
        upload_status: string;
        retention_status: string;
      }>(
        `SELECT pe.persistence_status, pe.is_current, so.upload_status,
          so.retention_status
         FROM project_exports pe
         JOIN storage_objects so ON so.id = pe.storage_object_id
         WHERE pe.project_id = $1`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          persistence_status: "FAILED",
          is_current: false,
          upload_status: "FAILED",
          retention_status: "PENDING_DELETE"
        }
      ]
    });
    await expect(
      query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM audit_events WHERE project_id = $1 AND action = 'EXPORT_GENERATED'",
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const recovery = await submitProjectExportJob({
      projectId: project.id,
      format: "MARKDOWN",
      idempotencyKey: `recover-${randomUUID()}`,
      actor: { actorType: "USER", actorLabel: "Recovery fixture operator" }
    });
    const recoveryWorker = worker(createExportJobHandler({ runtime }), "recovery");
    expect(await recoveryWorker.runOnce()).toBe(1);
    const recovered = await waitForIdle(recoveryWorker, recovery.job.id, ["SUCCEEDED"]);
    expect(recovered.output_reference).toMatchObject({
      projectId: project.id,
      format: "MARKDOWN",
      requestedBy: { actorType: "USER", actorLabel: "Recovery fixture operator" }
    });
    await expect(
      query<{
        exports: number;
        objects: number;
        active_objects: number;
        current_exports: number;
        recovered_audits: number;
      }>(
        `SELECT
          COUNT(DISTINCT pe.id)::integer AS exports,
          COUNT(DISTINCT so.id)::integer AS objects,
          (COUNT(DISTINCT so.id) FILTER (
            WHERE so.upload_status = 'AVAILABLE' AND so.retention_status = 'ACTIVE'
          ))::integer AS active_objects,
          (COUNT(DISTINCT pe.id) FILTER (
            WHERE pe.persistence_status = 'AVAILABLE' AND pe.is_current
          ))::integer AS current_exports,
          (COUNT(DISTINCT a.id) FILTER (
            WHERE a.after_state->>'recovered' = 'true'
          ))::integer AS recovered_audits
         FROM project_exports pe
         JOIN storage_objects so ON so.id = pe.storage_object_id
         LEFT JOIN audit_events a ON a.resource_id = pe.id AND a.action = 'EXPORT_GENERATED'
         WHERE pe.project_id = $1`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          exports: 1,
          objects: 1,
          active_objects: 1,
          current_exports: 1,
          recovered_audits: 1
        }
      ]
    });
  });
});
