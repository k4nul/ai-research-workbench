import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listDocumentsRoute, POST as uploadDocumentRoute } from "@/app/api/projects/[projectId]/documents/route";
import { DELETE as deleteDocumentRoute, GET as documentDetailRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/route";
import { GET as downloadDocumentRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/download/route";
import { POST as extractDocumentRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/extract/route";
import { POST as scanDocumentRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/scan/route";
import { POST as legacyUploadRoute } from "@/app/api/projects/[projectId]/sources/upload/route";
import { resetConfigForTests } from "@/lib/config";
import {
  extractTextDocument,
  extractPdfDocument,
  MockMalwareScanner,
  getDocumentRuntime,
  resetDocumentRuntimeForTests,
  type DocumentRuntime
} from "@/lib/documents";
import { closePool, query } from "@/lib/db";
import {
  DOCUMENT_JOB_TYPES,
  enqueueDocumentExtraction,
  enqueueDocumentScan
} from "@/lib/services/document-jobs";
import {
  extractDocument,
  getDocumentProcessingState,
  quarantineDocument,
  scanDocument,
  type DocumentActor
} from "@/lib/services/documents";
import { authenticateOperator, createOperator } from "@/lib/services/auth";
import {
  claimJobs,
  completeJob,
  getJob,
  heartbeatJob,
  recoverExpiredJobs,
  startJob,
  type JobRow
} from "@/lib/services/jobs";
import { createProject } from "@/lib/services/projects";
import { LocalObjectStorage, sha256Hex } from "@/lib/storage";
import { resetTestDatabase } from "@/tests/helpers/database";
import { DurableWorker } from "@/worker/durable-worker";
import { createDocumentJobHandlers } from "@/worker/document-handlers";

const loopback = "http://localhost:3100";
const systemActor: DocumentActor = {
  actorType: "SYSTEM",
  actorId: "document-api-worker-test",
  label: "Document API worker fixture"
};
const temporaryDirectories: string[] = [];

function intake(name: string) {
  return {
    mode: "detailed" as const,
    name,
    clientName: "Document API fixture client",
    coreQuestion: "Can protected document APIs drive durable processing safely?",
    background: "Synthetic document API fixture.",
    purpose: "Exercise authenticated document routes and workers.",
    audience: "Test reviewer",
    scope: "Synthetic uploaded documents only.",
    exclusions: "Real customer documents.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-30",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "DOCX", "ZIP"] as const,
    specialRequirements: "Fixture data only."
  };
}

function context(projectId: string, documentId?: string) {
  return {
    params: Promise.resolve({ projectId, ...(documentId ? { documentId } : {}) })
  } as never;
}

function worker(runtime: DocumentRuntime, suffix: string): DurableWorker {
  return new DurableWorker(createDocumentJobHandlers(runtime), {
    workerId: `document-worker-${suffix}`,
    concurrency: 1,
    pollIntervalMs: 10,
    leaseDurationMs: 2_000,
    heartbeatIntervalMs: 200,
    shutdownGraceMs: 2_000,
    log: () => undefined
  });
}

async function executeOne(
  durableWorker: DurableWorker,
  jobId: string
): Promise<JobRow> {
  expect(await durableWorker.runOnce()).toBe(1);
  let current = await getJob(jobId);
  for (
    let attempt = 0;
    attempt < 200 &&
    (!(["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"] as string[]).includes(
      current.status
    ) || durableWorker.activeJobCount !== 0);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await getJob(jobId);
  }
  expect(durableWorker.activeJobCount).toBe(0);
  return current;
}

async function claimAndStartDocumentJob(
  jobId: string,
  jobType: string,
  workerId: string
): Promise<JobRow> {
  const claimed = await claimJobs({
    workerId,
    limit: 10,
    leaseDurationMs: 30_000,
    jobTypes: [jobType]
  });
  const job = claimed.find((candidate) => candidate.id === jobId);
  expect(job).toBeDefined();
  return startJob(job!.id, workerId, job!.version);
}

async function expireRecoverAndReclaimDocumentJob(
  jobId: string,
  jobType: string,
  workerId: string
): Promise<JobRow> {
  await query(
    "UPDATE jobs SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
    [jobId]
  );
  const recovered = await recoverExpiredJobs({ limit: 10, random: () => 0 });
  expect(recovered.map((job) => job.id)).toContain(jobId);
  await query("UPDATE jobs SET scheduled_at = clock_timestamp() WHERE id = $1", [jobId]);
  return claimAndStartDocumentJob(jobId, jobType, workerId);
}

async function fixtureRuntime(scanner = new MockMalwareScanner()): Promise<DocumentRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "research-document-worker-"));
  temporaryDirectories.push(root);
  return {
    storage: new LocalObjectStorage({ root, defaultBucket: "private", maxReadBytes: 1_000_000 }),
    scanner,
    storageBucket: "private",
    maxUploadBytes: 1_000_000,
    maxObjectBytes: 1_000_000,
    maxScanBytes: 1_000_000,
    production: true,
    allowExplicitDemoBypass: false
  };
}

async function quarantineText(
  projectId: string,
  runtime: DocumentRuntime,
  text: string
) {
  return quarantineDocument(
    {
      projectId,
      file: {
        filename: "worker-evidence.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(text)
      },
      actor: systemActor,
      maxBytes: runtime.maxUploadBytes,
      bucket: runtime.storageBucket
    },
    runtime.storage
  );
}

function fenceFor(job: JobRow, workerId: string) {
  return {
    jobId: job.id,
    workerId,
    attempt: job.attempts,
    version: job.version
  };
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "research-document-api-"));
  temporaryDirectories.push(root);
  vi.stubEnv("STORAGE_PROVIDER", "local");
  vi.stubEnv("STORAGE_DIR", root);
  vi.stubEnv("MALWARE_SCANNER_PROVIDER", "mock");
  vi.stubEnv("MALWARE_ALLOW_DEMO_BYPASS", "false");
  vi.stubEnv("AUTH_DEMO_BYPASS", "true");
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

describe("protected document API and durable worker", () => {
  it("rejects an oversized streamed multipart body before parsing or persistence", async () => {
    vi.stubEnv("MAX_UPLOAD_BYTES", "16");
    resetConfigForTests();
    resetDocumentRuntimeForTests();
    const project = await createProject(intake("Bounded multipart upload"));
    const boundary = "bounded-upload-fixture";
    const oversized = new Uint8Array(300_000).fill(0x61);
    const response = await uploadDocumentRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        method: "POST",
        headers: {
          origin: loopback,
          "idempotency-key": "oversized-document-upload",
          "content-type": `multipart/form-data; boundary=${boundary}`
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          }
        }),
        duplex: "half"
      } as RequestInit & { duplex: "half" }),
      context(project.id)
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_SIZE" }
    });
    await expect(
      query<{ documents: number; objects: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM documents WHERE project_id = $1) AS documents,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $1) AS objects`,
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ documents: 0, objects: 0 }] });
  });

  it("preserves mixed-case multipart boundary tokens from browser uploads", async () => {
    const project = await createProject(intake("Mixed-case multipart boundary"));
    const boundary = "----WebKitFormBoundaryAbC123xYz";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      "",
      "Mixed-case boundary fixture",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="browser-fixture.txt"',
      "Content-Type: text/plain",
      "",
      "Synthetic browser upload evidence.",
      `--${boundary}--`,
      ""
    ].join("\r\n");
    const response = await uploadDocumentRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        method: "POST",
        headers: {
          origin: loopback,
          "idempotency-key": "mixed-case-multipart-boundary",
          "content-type": `Multipart/Form-Data; boundary=${boundary}`
        },
        body
      }),
      context(project.id)
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        document: { status: "QUARANTINED" },
        scanJob: { created: true }
      }
    });
    await expect(
      query<{ documents: number; objects: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM documents WHERE project_id = $1) AS documents,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $1) AS objects`,
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ documents: 1, objects: 1 }] });
  });

  it("accepts the preserved seeded project ID shape on document routes", async () => {
    const project = await createProject(intake("Legacy document project ID"));
    await query(
      `INSERT INTO research_projects (
         id, workspace_id, client_id, name, core_question, purpose, audience,
         scope, research_date, deliverable_formats
       )
       SELECT 'project-demo', workspace_id, client_id, 'Seeded demo compatibility',
         core_question, purpose, audience, scope, research_date, deliverable_formats
       FROM research_projects WHERE id = $1`,
      [project.id]
    );

    const response = await listDocumentsRoute(
      new Request(`${loopback}/api/projects/project-demo/documents`),
      context("project-demo")
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [] });
  });

  it("rejects an unbounded legacy upload project ID before persistence", async () => {
    const projectId = "p".repeat(501);
    const form = new FormData();
    form.set("file", new File(["bounded path fixture"], "fixture.txt", { type: "text/plain" }));
    const response = await legacyUploadRoute(
      new Request(`${loopback}/api/projects/${projectId}/sources/upload`, {
        method: "POST",
        headers: { origin: loopback, "idempotency-key": "bounded-project-path" },
        body: form
      }),
      context(projectId)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
    await expect(
      query<{ documents: number; objects: number; jobs: number }>(`SELECT
        (SELECT COUNT(*)::integer FROM documents) AS documents,
        (SELECT COUNT(*)::integer FROM storage_objects) AS objects,
        (SELECT COUNT(*)::integer FROM jobs) AS jobs`)
    ).resolves.toMatchObject({ rows: [{ documents: 0, objects: 0, jobs: 0 }] });
  });

  it("preserves the legacy source-upload URL with idempotent private quarantine for text formats", async () => {
    const project = await createProject(intake("Legacy document upload compatibility"));
    const fixtures = [
      {
        name: "legacy-data.json",
        type: "application/json",
        content: '{"fixture":"private JSON evidence"}',
        driftContent: '{"fixture":"changed private JSON evidence"}'
      },
      {
        name: "legacy-data.csv",
        type: "text/csv",
        content: "metric,value\nprivate_fixture,1\n",
        driftContent: "metric,value\nprivate_fixture,2\n"
      },
      {
        name: "legacy-notes.md",
        type: "text/markdown",
        content: "# Private fixture\n\nSynthetic Markdown evidence.",
        driftContent: "# Private fixture\n\nChanged synthetic Markdown evidence."
      }
    ] as const;

    for (const fixture of fixtures) {
      const idempotencyKey = `legacy-upload-${fixture.name}`;
      const request = (content: string) => {
        const form = new FormData();
        form.set("file", new File([content], fixture.name, { type: fixture.type }));
        return new Request(`${loopback}/api/projects/${project.id}/sources/upload`, {
          method: "POST",
          headers: { origin: loopback, "idempotency-key": idempotencyKey },
          body: form
        });
      };

      const response = await legacyUploadRoute(request(fixture.content), context(project.id));
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        data: {
          id: string;
          document_id: string;
          document_status: string;
          scan_job: { jobId: string; created: boolean };
        };
      };
      expect(body.data).toMatchObject({
        document_id: expect.any(String),
        document_status: "QUARANTINED",
        scan_job: { jobId: expect.any(String), created: true }
      });
      const persisted = await query<{
        sanitized_content: string | null;
        object_id: string;
        provider: string;
        sha256: string;
      }>(
        `SELECT s.sanitized_content, so.id AS object_id, so.provider, so.sha256
           FROM sources s
           JOIN documents d ON d.source_id = s.id
           JOIN storage_objects so ON so.id = d.raw_object_id
          WHERE s.id = $1 AND d.id = $2`,
        [body.data.id, body.data.document_id]
      );
      expect(persisted.rows).toEqual([
        {
          sanitized_content: null,
          object_id: expect.any(String),
          provider: "LOCAL",
          sha256: sha256Hex(new TextEncoder().encode(fixture.content))
        }
      ]);

      const replay = await legacyUploadRoute(request(fixture.content), context(project.id));
      expect(replay.status).toBe(201);
      await expect(replay.json()).resolves.toMatchObject({
        data: {
          id: body.data.id,
          document_id: body.data.document_id,
          document_status: "QUARANTINED",
          scan_job: { jobId: body.data.scan_job.jobId, created: false }
        }
      });
      await expect(
        query<{ documents: number; objects: number; jobs: number }>(
          `SELECT
             (SELECT COUNT(*)::integer FROM documents WHERE id = $1) AS documents,
             (SELECT COUNT(*)::integer FROM storage_objects WHERE id = $2) AS objects,
             (SELECT COUNT(*)::integer FROM jobs WHERE id = $3) AS jobs`,
          [body.data.document_id, persisted.rows[0].object_id, body.data.scan_job.jobId]
        )
      ).resolves.toMatchObject({ rows: [{ documents: 1, objects: 1, jobs: 1 }] });

      const drift = await legacyUploadRoute(
        request(fixture.driftContent),
        context(project.id)
      );
      expect(drift.status).toBe(409);
      await expect(drift.json()).resolves.toMatchObject({
        error: { code: "IDEMPOTENCY_KEY_REUSED" }
      });
    }
  });

  it("fences an expired scan attempt and lets its reclaimed attempt reuse the clean object", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document scan lease fence"));
    const document = await quarantineText(project.id, runtime, "Lease-fenced scan fixture.");
    const submitted = await enqueueDocumentScan({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "scan-lease-fence",
      autoExtract: false,
      actor: systemActor
    });
    const runningA = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.scan,
      "scan-worker-a"
    );
    let runningB: JobRow | undefined;
    const scanner = {
      name: "reassigning-mock-scanner",
      async scan(input: Parameters<MockMalwareScanner["scan"]>[0]) {
        const result = await new MockMalwareScanner().scan(input);
        runningB = await expireRecoverAndReclaimDocumentJob(
          runningA.id,
          DOCUMENT_JOB_TYPES.scan,
          "scan-worker-b"
        );
        return result;
      }
    };
    const staleHandler = createDocumentJobHandlers({ ...runtime, scanner }).get(
      DOCUMENT_JOB_TYPES.scan
    );
    expect(staleHandler).toBeDefined();

    await expect(
      staleHandler!({
        job: runningA,
        workerId: "scan-worker-a",
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(runningB).toBeDefined();
    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("SCANNING");
    await expect(
      query<{ scans: number; clean_objects: number; final_audits: number; sanitized: string | null }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_scan_results WHERE document_id = $1) AS scans,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $2 AND object_key LIKE 'sources/%') AS clean_objects,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action IN ('DOCUMENT_SCAN_CLEAN', 'DOCUMENT_SCAN_BLOCKED')) AS final_audits,
          (SELECT sanitized_content FROM sources WHERE id = $3) AS sanitized`,
        [document.id, project.id, document.sourceId]
      )
    ).resolves.toMatchObject({
      rows: [{ scans: 0, clean_objects: 0, final_audits: 0, sanitized: null }]
    });
    expect(await runtime.storage.list("sources")).toHaveLength(1);

    const currentHandler = createDocumentJobHandlers(runtime).get(DOCUMENT_JOB_TYPES.scan);
    expect(currentHandler).toBeDefined();
    const output = await currentHandler!({
      job: runningB!,
      workerId: "scan-worker-b",
      signal: new AbortController().signal
    });
    await completeJob({
      jobId: runningB!.id,
      workerId: "scan-worker-b",
      outputReference: output
    });

    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("CLEAN");
    const clean = await query<{
      bucket: string;
      object_key: string;
      sha256: string;
      byte_size: string;
    }>(
      "SELECT bucket, object_key, sha256, byte_size::text FROM storage_objects WHERE project_id = $1 AND object_key LIKE 'sources/%'",
      [project.id]
    );
    expect(clean.rows).toHaveLength(1);
    await expect(
      runtime.storage.read(
        { bucket: clean.rows[0].bucket, key: clean.rows[0].object_key },
        { maxBytes: runtime.maxObjectBytes, expectedSha256: clean.rows[0].sha256 }
      )
    ).resolves.toHaveLength(Number(clean.rows[0].byte_size));
    await expect(
      query<{ scans: number; final_audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_scan_results WHERE document_id = $1) AS scans,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_SCAN_CLEAN') AS final_audits`,
        [document.id, project.id]
      )
    ).resolves.toMatchObject({ rows: [{ scans: 1, final_audits: 1 }] });
  });

  it("rejects reclaimed scan and extraction attempts before their initial state transitions", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document initial lease fences"));
    const scanDocumentFixture = await quarantineText(
      project.id,
      runtime,
      "Stale scan must not enter SCANNING."
    );
    const scanSubmission = await enqueueDocumentScan({
      projectId: project.id,
      documentId: scanDocumentFixture.id,
      idempotencyKey: "initial-scan-lease-fence",
      autoExtract: false,
      actor: systemActor
    });
    const staleScan = await claimAndStartDocumentJob(
      scanSubmission.jobId,
      DOCUMENT_JOB_TYPES.scan,
      "initial-scan-worker-a"
    );
    await expireRecoverAndReclaimDocumentJob(
      staleScan.id,
      DOCUMENT_JOB_TYPES.scan,
      "initial-scan-worker-b"
    );

    await expect(
      scanDocument(
        project.id,
        scanDocumentFixture.id,
        runtime.storage,
        runtime.scanner,
        {
          maxBytes: runtime.maxScanBytes,
          production: runtime.production,
          actor: systemActor,
          jobFence: fenceFor(staleScan, "initial-scan-worker-a")
        }
      )
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    await expect(
      query<{ status: string; scan_status: string; scans: number; final_audits: number }>(
        `SELECT d.status, so.scan_status,
          (SELECT COUNT(*)::integer FROM document_scan_results WHERE document_id = d.id) AS scans,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = d.project_id AND action IN ('DOCUMENT_SCAN_CLEAN', 'DOCUMENT_SCAN_BLOCKED')) AS final_audits
         FROM documents d JOIN storage_objects so ON so.id = d.raw_object_id
         WHERE d.id = $1`,
        [scanDocumentFixture.id]
      )
    ).resolves.toMatchObject({
      rows: [{ status: "QUARANTINED", scan_status: "UNSCANNED", scans: 0, final_audits: 0 }]
    });

    const extractDocumentFixture = await quarantineText(
      project.id,
      runtime,
      "Stale extraction must not enter EXTRACTING."
    );
    await scanDocument(project.id, extractDocumentFixture.id, runtime.storage, runtime.scanner, {
      maxBytes: runtime.maxScanBytes,
      production: runtime.production,
      actor: systemActor
    });
    const extractSubmission = await enqueueDocumentExtraction({
      projectId: project.id,
      documentId: extractDocumentFixture.id,
      idempotencyKey: "initial-extract-lease-fence",
      actor: systemActor
    });
    const staleExtract = await claimAndStartDocumentJob(
      extractSubmission.jobId,
      DOCUMENT_JOB_TYPES.extract,
      "initial-extract-worker-a"
    );
    await expireRecoverAndReclaimDocumentJob(
      staleExtract.id,
      DOCUMENT_JOB_TYPES.extract,
      "initial-extract-worker-b"
    );

    await expect(
      extractDocument(project.id, extractDocumentFixture.id, runtime.storage, {
        maxBytes: runtime.maxObjectBytes,
        production: runtime.production,
        actor: systemActor,
        jobFence: fenceFor(staleExtract, "initial-extract-worker-a")
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    await expect(
      query<{
        status: string;
        extraction_status: string;
        extractions: number;
        final_audits: number;
        sanitized: string | null;
      }>(
        `SELECT d.status, so.extraction_status,
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = d.id) AS extractions,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = d.project_id AND action IN ('DOCUMENT_EXTRACTION_READY', 'DOCUMENT_EXTRACTION_FAILED', 'DOCUMENT_OCR_REQUIRED')) AS final_audits,
          s.sanitized_content AS sanitized
         FROM documents d
         JOIN storage_objects so ON so.id = d.raw_object_id
         JOIN sources s ON s.id = d.source_id
         WHERE d.id = $1`,
        [extractDocumentFixture.id]
      )
    ).resolves.toMatchObject({
      rows: [{
        status: "CLEAN",
        extraction_status: "NOT_REQUESTED",
        extractions: 0,
        final_audits: 0,
        sanitized: null
      }]
    });
  });

  it("accepts a healthy heartbeat version advance under the claimed document fence", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document heartbeat fence"));
    const document = await quarantineText(project.id, runtime, "Healthy heartbeat fixture.");
    const submitted = await enqueueDocumentScan({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "heartbeat-version-scan-fence",
      autoExtract: false,
      actor: systemActor
    });
    const running = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.scan,
      "heartbeat-scan-worker"
    );
    const heartbeat = await heartbeatJob({
      jobId: running.id,
      workerId: "heartbeat-scan-worker",
      leaseDurationMs: 30_000
    });
    expect(BigInt(heartbeat.version)).toBeGreaterThan(BigInt(running.version));

    const result = await scanDocument(
      project.id,
      document.id,
      runtime.storage,
      runtime.scanner,
      {
        maxBytes: runtime.maxScanBytes,
        production: runtime.production,
        actor: systemActor,
        jobFence: fenceFor(running, "heartbeat-scan-worker")
      }
    );
    expect(result.status).toBe("CLEAN");
    await completeJob({
      jobId: running.id,
      workerId: "heartbeat-scan-worker",
      outputReference: { documentId: document.id, status: result.status }
    });
  });

  it("fences stale extraction success effects before reclaimed completion", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document extraction lease fence"));
    const document = await quarantineText(
      project.id,
      runtime,
      "Lease-fenced extraction paragraph."
    );
    await scanDocument(project.id, document.id, runtime.storage, runtime.scanner, {
      maxBytes: runtime.maxScanBytes,
      production: runtime.production,
      actor: systemActor
    });
    const submitted = await enqueueDocumentExtraction({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "extract-lease-fence",
      actor: systemActor
    });
    const runningA = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.extract,
      "extract-worker-a"
    );
    let runningB: JobRow | undefined;

    await expect(
      extractDocument(project.id, document.id, runtime.storage, {
        maxBytes: runtime.maxObjectBytes,
        production: runtime.production,
        actor: systemActor,
        jobFence: {
          jobId: runningA.id,
          workerId: "extract-worker-a",
          attempt: runningA.attempts,
          version: runningA.version
        },
        extractor: async ({ bytes, limits }) => {
          runningB = await expireRecoverAndReclaimDocumentJob(
            runningA.id,
            DOCUMENT_JOB_TYPES.extract,
            "extract-worker-b"
          );
          return extractTextDocument(bytes, limits);
        }
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(runningB).toBeDefined();
    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("EXTRACTING");
    await expect(
      query<{
        extractions: number;
        blocks: number;
        chunks: number;
        ready_audits: number;
        failed_audits: number;
        sanitized: string | null;
      }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1) AS extractions,
          (SELECT COUNT(*)::integer FROM document_blocks b JOIN document_extractions e ON e.id = b.extraction_id WHERE e.document_id = $1) AS blocks,
          (SELECT COUNT(*)::integer FROM document_chunks c JOIN document_extractions e ON e.id = c.extraction_id WHERE e.document_id = $1) AS chunks,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_READY') AS ready_audits,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_FAILED') AS failed_audits,
          (SELECT sanitized_content FROM sources WHERE id = $3) AS sanitized`,
        [document.id, project.id, document.sourceId]
      )
    ).resolves.toMatchObject({
      rows: [{
        extractions: 0,
        blocks: 0,
        chunks: 0,
        ready_audits: 0,
        failed_audits: 0,
        sanitized: null
      }]
    });
    expect(await runtime.storage.list("extractions")).toHaveLength(1);

    const currentHandler = createDocumentJobHandlers(runtime).get(DOCUMENT_JOB_TYPES.extract);
    expect(currentHandler).toBeDefined();
    const output = await currentHandler!({
      job: runningB!,
      workerId: "extract-worker-b",
      signal: new AbortController().signal
    });
    await completeJob({
      jobId: runningB!.id,
      workerId: "extract-worker-b",
      outputReference: output
    });

    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("READY");
    const artifact = await query<{
      bucket: string;
      object_key: string;
      sha256: string;
      byte_size: string;
    }>(
      "SELECT bucket, object_key, sha256, byte_size::text FROM storage_objects WHERE project_id = $1 AND object_key LIKE 'extractions/%'",
      [project.id]
    );
    expect(artifact.rows).toHaveLength(1);
    await expect(
      runtime.storage.read(
        { bucket: artifact.rows[0].bucket, key: artifact.rows[0].object_key },
        { maxBytes: runtime.maxObjectBytes, expectedSha256: artifact.rows[0].sha256 }
      )
    ).resolves.toHaveLength(Number(artifact.rows[0].byte_size));
    await expect(
      query<{ succeeded: number; failed: number; ready_audits: number; failed_audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'SUCCEEDED') AS succeeded,
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'FAILED') AS failed,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_READY') AS ready_audits,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_FAILED') AS failed_audits`,
        [document.id, project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ succeeded: 1, failed: 0, ready_audits: 1, failed_audits: 0 }]
    });
  });

  it("fences extraction failure recording after the attempt is reclaimed", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document extraction failure fence"));
    const document = await quarantineText(
      project.id,
      runtime,
      "Lease-fenced extraction failure paragraph."
    );
    await scanDocument(project.id, document.id, runtime.storage, runtime.scanner, {
      maxBytes: runtime.maxScanBytes,
      production: runtime.production,
      actor: systemActor
    });
    const submitted = await enqueueDocumentExtraction({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "extract-failure-lease-fence",
      actor: systemActor
    });
    const runningA = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.extract,
      "extract-failure-worker-a"
    );
    let runningB: JobRow | undefined;

    await expect(
      extractDocument(project.id, document.id, runtime.storage, {
        maxBytes: runtime.maxObjectBytes,
        production: runtime.production,
        actor: systemActor,
        jobFence: {
          jobId: runningA.id,
          workerId: "extract-failure-worker-a",
          attempt: runningA.attempts,
          version: runningA.version
        },
        extractor: async () => {
          runningB = await expireRecoverAndReclaimDocumentJob(
            runningA.id,
            DOCUMENT_JOB_TYPES.extract,
            "extract-failure-worker-b"
          );
          throw new Error("Synthetic stale extractor failure.");
        }
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(runningB).toBeDefined();
    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("EXTRACTING");
    await expect(
      query<{ failed: number; failed_audits: number; sanitized: string | null }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'FAILED') AS failed,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_FAILED') AS failed_audits,
          (SELECT sanitized_content FROM sources WHERE id = $3) AS sanitized`,
        [document.id, project.id, document.sourceId]
      )
    ).resolves.toMatchObject({
      rows: [{ failed: 0, failed_audits: 0, sanitized: null }]
    });

    const handler = createDocumentJobHandlers(runtime).get(DOCUMENT_JOB_TYPES.extract);
    expect(handler).toBeDefined();
    const output = await handler!({
      job: runningB!,
      workerId: "extract-failure-worker-b",
      signal: new AbortController().signal
    });
    await completeJob({
      jobId: runningB!.id,
      workerId: "extract-failure-worker-b",
      outputReference: output
    });
    await expect(
      query<{ succeeded: number; failed: number; ready_audits: number; failed_audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'SUCCEEDED') AS succeeded,
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'FAILED') AS failed,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_READY') AS ready_audits,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_FAILED') AS failed_audits`,
        [document.id, project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ succeeded: 1, failed: 0, ready_audits: 1, failed_audits: 0 }]
    });
  });

  it("fences a stale OCR finalization and lets the reclaimed attempt reuse its artifact", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Document OCR lease fence"));
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const document = await quarantineDocument(
      {
        projectId: project.id,
        file: {
          filename: "ocr-required.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array(await pdf.save())
        },
        actor: systemActor,
        maxBytes: runtime.maxUploadBytes,
        bucket: runtime.storageBucket
      },
      runtime.storage
    );
    await scanDocument(project.id, document.id, runtime.storage, runtime.scanner, {
      maxBytes: runtime.maxScanBytes,
      production: runtime.production,
      actor: systemActor
    });
    const submitted = await enqueueDocumentExtraction({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "ocr-final-lease-fence",
      actor: systemActor
    });
    const runningA = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.extract,
      "ocr-worker-a"
    );
    let runningB: JobRow | undefined;

    await expect(
      extractDocument(project.id, document.id, runtime.storage, {
        maxBytes: runtime.maxObjectBytes,
        production: runtime.production,
        actor: systemActor,
        jobFence: fenceFor(runningA, "ocr-worker-a"),
        extractor: async ({ bytes, limits }) => {
          const result = await extractPdfDocument(bytes, limits);
          runningB = await expireRecoverAndReclaimDocumentJob(
            runningA.id,
            DOCUMENT_JOB_TYPES.extract,
            "ocr-worker-b"
          );
          return result;
        }
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(runningB).toBeDefined();
    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe("EXTRACTING");
    await expect(
      query<{ extractions: number; objects: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1) AS extractions,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $2 AND object_key LIKE 'extractions/%') AS objects,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_OCR_REQUIRED') AS audits`,
        [document.id, project.id]
      )
    ).resolves.toMatchObject({ rows: [{ extractions: 0, objects: 0, audits: 0 }] });
    expect(await runtime.storage.list("extractions")).toHaveLength(1);

    const handler = createDocumentJobHandlers(runtime).get(DOCUMENT_JOB_TYPES.extract);
    expect(handler).toBeDefined();
    const output = await handler!({
      job: runningB!,
      workerId: "ocr-worker-b",
      signal: new AbortController().signal
    });
    await completeJob({
      jobId: runningB!.id,
      workerId: "ocr-worker-b",
      outputReference: output
    });
    expect((await getDocumentProcessingState(project.id, document.id)).status).toBe(
      "OCR_REQUIRED_UNSUPPORTED"
    );
    const artifact = await query<{
      bucket: string;
      object_key: string;
      sha256: string;
      byte_size: string;
    }>(
      "SELECT bucket, object_key, sha256, byte_size::text FROM storage_objects WHERE project_id = $1 AND object_key LIKE 'extractions/%'",
      [project.id]
    );
    expect(artifact.rows).toHaveLength(1);
    await expect(
      runtime.storage.read(
        { bucket: artifact.rows[0].bucket, key: artifact.rows[0].object_key },
        { maxBytes: runtime.maxObjectBytes, expectedSha256: artifact.rows[0].sha256 }
      )
    ).resolves.toHaveLength(Number(artifact.rows[0].byte_size));
    await expect(
      query<{ ocr: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM document_extractions WHERE document_id = $1 AND status = 'OCR_REQUIRED_UNSUPPORTED') AS ocr,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_OCR_REQUIRED') AS audits`,
        [document.id, project.id]
      )
    ).resolves.toMatchObject({ rows: [{ ocr: 1, audits: 1 }] });
  });

  it("fences extraction child submission after a scan lease is reassigned", async () => {
    const runtime = await fixtureRuntime();
    const project = await createProject(intake("Post-scan child lease fence"));
    const document = await quarantineText(project.id, runtime, "Post-scan child fixture.");
    const submitted = await enqueueDocumentScan({
      projectId: project.id,
      documentId: document.id,
      idempotencyKey: "post-scan-child-fence",
      autoExtract: true,
      actor: systemActor
    });
    const runningA = await claimAndStartDocumentJob(
      submitted.jobId,
      DOCUMENT_JOB_TYPES.scan,
      "post-scan-worker-a"
    );
    await scanDocument(project.id, document.id, runtime.storage, runtime.scanner, {
      maxBytes: runtime.maxScanBytes,
      production: runtime.production,
      actor: systemActor,
      jobFence: {
        jobId: runningA.id,
        workerId: "post-scan-worker-a",
        attempt: runningA.attempts,
        version: runningA.version
      }
    });
    const runningB = await expireRecoverAndReclaimDocumentJob(
      runningA.id,
      DOCUMENT_JOB_TYPES.scan,
      "post-scan-worker-b"
    );

    await expect(
      enqueueDocumentExtraction({
        projectId: project.id,
        documentId: document.id,
        idempotencyKey: `after-scan:${runningA.id}`,
        actor: systemActor,
        parentJobId: runningA.id,
        correlationId: runningA.correlation_id,
        parentJobFence: {
          jobId: runningA.id,
          workerId: "post-scan-worker-a",
          attempt: runningA.attempts,
          version: runningA.version
        }
      })
    ).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    await expect(
      query<{ jobs: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM jobs WHERE parent_job_id = $1 AND job_type = 'DOCUMENT_EXTRACT') AS jobs,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_REQUESTED') AS audits`,
        [runningA.id, project.id]
      )
    ).resolves.toMatchObject({ rows: [{ jobs: 0, audits: 0 }] });

    const handler = createDocumentJobHandlers(runtime).get(DOCUMENT_JOB_TYPES.scan);
    expect(handler).toBeDefined();
    const output = await handler!({
      job: runningB,
      workerId: "post-scan-worker-b",
      signal: new AbortController().signal
    });
    await completeJob({
      jobId: runningB.id,
      workerId: "post-scan-worker-b",
      outputReference: output
    });
    await expect(
      query<{ jobs: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM jobs WHERE parent_job_id = $1 AND job_type = 'DOCUMENT_EXTRACT') AS jobs,
          (SELECT COUNT(*)::integer FROM audit_events WHERE project_id = $2 AND action = 'DOCUMENT_EXTRACTION_REQUESTED') AS audits`,
        [runningA.id, project.id]
      )
    ).resolves.toMatchObject({ rows: [{ jobs: 1, audits: 1 }] });
  });

  it("authenticates, deduplicates jobs, reaches READY through workers, re-extracts, downloads, and cleans up", async () => {
    vi.stubEnv("AUTH_DEMO_BYPASS", "false");
    await createOperator({
      username: "document.operator",
      displayName: "Document Operator",
      password: "correct document fixture password"
    });
    const session = await authenticateOperator({
      username: "document.operator",
      password: "correct document fixture password"
    });
    const cookie = `arw_session=${session.sessionToken}; arw_csrf=${session.csrfToken}`;
    const project = await createProject(intake("Protected document workflow"));
    const otherProject = await createProject(intake("Cross-project document boundary"));

    const missingAuth = await listDocumentsRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`),
      context(project.id)
    );
    expect(missingAuth.status).toBe(401);

    const form = new FormData();
    form.set(
      "file",
      new File(
        ["Worker evidence paragraph one.\n\nWorker evidence paragraph two."],
        "worker-evidence.txt",
        { type: "text/plain" }
      )
    );
    form.set("title", "Worker evidence upload");
    const upload = await uploadDocumentRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        method: "POST",
        headers: {
          cookie,
          origin: loopback,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": "document-upload-stable-1"
        },
        body: form
      }),
      context(project.id)
    );
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as {
      data: {
        document: { id: string; status: string; sourceId: string; objectId: string };
        scanJob: { jobId: string; created: boolean };
      };
    };
    expect(uploaded.data.document.status).toBe("QUARANTINED");
    expect(uploaded.data.scanJob.created).toBe(true);

    const replayForm = new FormData();
    replayForm.set(
      "file",
      new File(
        ["Worker evidence paragraph one.\n\nWorker evidence paragraph two."],
        "worker-evidence.txt",
        { type: "text/plain" }
      )
    );
    replayForm.set("title", "Worker evidence upload");
    const replay = await uploadDocumentRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        method: "POST",
        headers: {
          cookie,
          origin: loopback,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": "document-upload-stable-1"
        },
        body: replayForm
      }),
      context(project.id)
    );
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        document: {
          id: uploaded.data.document.id,
          objectId: uploaded.data.document.objectId
        },
        scanJob: { jobId: uploaded.data.scanJob.jobId, created: false }
      }
    });
    await expect(
      query<{ documents: number; objects: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM documents WHERE project_id = $1) AS documents,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $1) AS objects`,
        [project.id]
      )
    ).resolves.toMatchObject({ rows: [{ documents: 1, objects: 1 }] });

    const mismatchedForm = new FormData();
    mismatchedForm.set(
      "file",
      new File(["Different upload bytes."], "worker-evidence.txt", { type: "text/plain" })
    );
    mismatchedForm.set("title", "Worker evidence upload");
    const mismatched = await uploadDocumentRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        method: "POST",
        headers: {
          cookie,
          origin: loopback,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": "document-upload-stable-1"
        },
        body: mismatchedForm
      }),
      context(project.id)
    );
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });

    const missingCsrf = await scanDocumentRoute(
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}/scan`,
        {
          method: "POST",
          headers: { cookie, origin: loopback, "idempotency-key": "initial-scan" }
        }
      ),
      context(project.id, uploaded.data.document.id)
    );
    expect(missingCsrf.status).toBe(403);

    const duplicateScan = await scanDocumentRoute(
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}/scan`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: loopback,
            "x-csrf-token": session.csrfToken,
            "idempotency-key": "initial-scan"
          }
        }
      ),
      context(project.id, uploaded.data.document.id)
    );
    expect(duplicateScan.status).toBe(202);
    await expect(duplicateScan.json()).resolves.toMatchObject({
      data: { jobId: uploaded.data.scanJob.jobId, created: false }
    });

    const runtime = getDocumentRuntime();
    const processingWorker = worker(runtime, "clean");
    const scannedJob = await executeOne(processingWorker, uploaded.data.scanJob.jobId);
    expect(scannedJob.status).toBe("SUCCEEDED");
    const child = await query<{ id: string }>(
      "SELECT id FROM jobs WHERE parent_job_id = $1 AND job_type = 'DOCUMENT_EXTRACT'",
      [uploaded.data.scanJob.jobId]
    );
    expect(child.rows).toHaveLength(1);
    const extractedJob = await executeOne(processingWorker, child.rows[0].id);
    expect(extractedJob.status).toBe("SUCCEEDED");
    expect((await getDocumentProcessingState(project.id, uploaded.data.document.id)).status).toBe(
      "READY"
    );

    const listed = await listDocumentsRoute(
      new Request(`${loopback}/api/projects/${project.id}/documents`, {
        headers: { cookie }
      }),
      context(project.id)
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{ id: uploaded.data.document.id, status: "READY", title: "Worker evidence upload" }]
    });
    const detail = await documentDetailRoute(
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}`,
        { headers: { cookie } }
      ),
      context(project.id, uploaded.data.document.id)
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: {
        document: { status: "READY" },
        scans: [{ result: "CLEAN" }],
        extractions: [{ status: "SUCCEEDED", version: 1 }]
      }
    });

    const crossProject = await downloadDocumentRoute(
      new Request(
        `${loopback}/api/projects/${otherProject.id}/documents/${uploaded.data.document.id}/download`,
        { headers: { cookie } }
      ),
      context(otherProject.id, uploaded.data.document.id)
    );
    expect(crossProject.status).toBe(404);
    const download = await downloadDocumentRoute(
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}/download`,
        { headers: { cookie } }
      ),
      context(project.id, uploaded.data.document.id)
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("worker-evidence.txt");
    expect(await download.text()).toContain("Worker evidence paragraph one.");

    const manualExtract = await extractDocumentRoute(
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}/extract`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: loopback,
            "x-csrf-token": session.csrfToken,
            "idempotency-key": "manual-v2"
          }
        }
      ),
      context(project.id, uploaded.data.document.id)
    );
    expect(manualExtract.status).toBe(202);
    const manual = (await manualExtract.json()) as { data: { jobId: string; created: boolean } };
    expect(manual.data.created).toBe(true);
    expect((await executeOne(processingWorker, manual.data.jobId)).status).toBe("SUCCEEDED");
    expect(
      (
        await query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM document_extractions WHERE document_id = $1 AND status = 'SUCCEEDED'",
          [uploaded.data.document.id]
        )
      ).rows[0].count
    ).toBe(2);
    await processingWorker.stop();

    const locations = await query<{
      id: string;
      bucket: string;
      object_key: string;
    }>(
      `SELECT id, bucket, object_key FROM storage_objects
       WHERE project_id = $1
         AND (id = $2 OR source_id = $3)
       ORDER BY id`,
      [
        project.id,
        uploaded.data.document.objectId,
        uploaded.data.document.sourceId
      ]
    );
    expect(locations.rows).toHaveLength(4);
    const deleteRequest = (idempotencyKey: string) =>
      new Request(
        `${loopback}/api/projects/${project.id}/documents/${uploaded.data.document.id}`,
        {
          method: "DELETE",
          headers: {
            cookie,
            origin: loopback,
            "x-csrf-token": session.csrfToken,
            "idempotency-key": idempotencyKey
          }
        }
      );
    const deleted = await deleteDocumentRoute(
      deleteRequest("document-delete-stable-1"),
      context(project.id, uploaded.data.document.id)
    );
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      data: {
        documentId: string;
        objectIds: string[];
        cleanupJobId: string;
        cleanupStatus: string;
      };
    };
    expect(deletedBody).toMatchObject({
      data: {
        documentId: uploaded.data.document.id,
        objectIds: locations.rows.map((location) => location.id),
        cleanupJobId: expect.any(String),
        cleanupStatus: "PENDING_DELETE"
      }
    });
    const deleteReplay = await deleteDocumentRoute(
      deleteRequest("document-delete-stable-1"),
      context(project.id, uploaded.data.document.id)
    );
    expect(deleteReplay.status).toBe(200);
    await expect(deleteReplay.json()).resolves.toEqual(deletedBody);
    await expect(
      query<{
        id: string;
        input_reference: { objectIds: string[]; deleteUntracked: boolean; limit: number };
      }>(
        `SELECT id, input_reference FROM jobs
         WHERE project_id = $1 AND idempotency_key = $2`,
        [project.id, `document-delete:${uploaded.data.document.id}:storage-cleanup`]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          id: deletedBody.data.cleanupJobId,
          input_reference: {
            objectIds: locations.rows.map((location) => location.id),
            deleteUntracked: false,
            limit: 1_000
          }
        }
      ]
    });
    const cleanupWorker = worker(runtime, "cleanup");
    expect((await executeOne(cleanupWorker, deletedBody.data.cleanupJobId)).status).toBe(
      "SUCCEEDED"
    );
    await cleanupWorker.stop();
    for (const location of locations.rows) {
      expect(
        await runtime.storage.head({
          bucket: location.bucket,
          key: location.object_key
        })
      ).toBeNull();
    }
    await expect(
      query<{ deleted: number }>(
        `SELECT COUNT(*)::integer AS deleted FROM storage_objects
         WHERE id = ANY($1::text[])
           AND retention_status = 'DELETED'
           AND upload_status = 'DELETED'`,
        [locations.rows.map((location) => location.id)]
      )
    ).resolves.toMatchObject({ rows: [{ deleted: 4 }] });
    const afterCleanupReplay = await deleteDocumentRoute(
      deleteRequest("document-delete-stable-2"),
      context(project.id, uploaded.data.document.id)
    );
    expect(afterCleanupReplay.status).toBe(200);
    await expect(afterCleanupReplay.json()).resolves.toEqual(deletedBody);
    await expect(
      query<{ jobs: number; deleted: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM jobs
            WHERE project_id = $1 AND job_type = 'STORAGE_CLEANUP') AS jobs,
          (SELECT COUNT(*)::integer FROM storage_objects
            WHERE id = ANY($2::text[]) AND retention_status = 'DELETED') AS deleted,
          (SELECT COUNT(*)::integer FROM audit_events
            WHERE project_id = $1 AND action = 'DOCUMENT_DELETE_REQUESTED') AS audits`,
        [project.id, locations.rows.map((location) => location.id)]
      )
    ).resolves.toMatchObject({ rows: [{ jobs: 1, deleted: 4, audits: 1 }] });
  });

  it.each([
    { name: "infected", result: "INFECTED" as const, expected: "REJECTED" },
    {
      name: "scanner unavailable",
      result: "ERROR" as const,
      expected: "BLOCKED_SCANNER_UNAVAILABLE"
    },
    {
      name: "scanner timeout",
      result: "TIMEOUT" as const,
      expected: "BLOCKED_SCANNER_UNAVAILABLE"
    }
  ])("keeps $name worker results fail closed and never enqueues extraction", async (fixture) => {
    const scanner = new MockMalwareScanner({ result: fixture.result });
    const runtime = await fixtureRuntime(scanner);
    const project = await createProject(intake(`Fail-closed ${fixture.name}`));
    const quarantined = await quarantineText(
      project.id,
      runtime,
      `Deterministic ${fixture.name} worker fixture.`
    );
    const scan = await enqueueDocumentScan({
      projectId: project.id,
      documentId: quarantined.id,
      idempotencyKey: fixture.name.replace(/\s+/g, "-"),
      autoExtract: true,
      actor: systemActor
    });
    const durableWorker = worker(runtime, fixture.name.replace(/\s+/g, "-"));
    expect((await executeOne(durableWorker, scan.jobId)).status).toBe("SUCCEEDED");
    await durableWorker.stop();
    expect((await getDocumentProcessingState(project.id, quarantined.id)).status).toBe(
      fixture.expected
    );
    const extractionJobs = await query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM jobs" +
        " WHERE job_type = 'DOCUMENT_EXTRACT' AND input_reference ->> 'documentId' = $1",
      [quarantined.id]
    );
    expect(extractionJobs.rows[0].count).toBe(0);
    const source = await query<{ sanitized_content: string | null }>(
      "SELECT sanitized_content FROM sources WHERE id = $1",
      [quarantined.sourceId]
    );
    expect(source.rows[0].sanitized_content).toBeNull();
  });
});
