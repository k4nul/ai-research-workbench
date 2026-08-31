import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "@/lib/db";
import {
  deleteDocument,
  extractDocument,
  quarantineDocument,
  readDocumentObject,
  scanDocument,
  type DocumentActor
} from "@/lib/services/documents";
import { cleanupOrphanObjects, PostgresStorageObjectCatalog } from "@/lib/services/orphan-cleanup";
import { createProject, deleteProject } from "@/lib/services/projects";
import { addEvidence } from "@/lib/services/sources";
import { MockMalwareScanner } from "@/lib/documents/scanner";
import { LocalObjectStorage, sha256Hex, type ObjectStorage } from "@/lib/storage";
import {
  claimJobs,
  completeJob,
  requestJobCancellation,
  startJob,
  submitJob
} from "@/lib/services/jobs";
import { resetTestDatabase } from "@/tests/helpers/database";

const actor: DocumentActor = {
  actorType: "USER",
  actorId: "operator-document-test",
  label: "Document integration operator"
};
const worker: DocumentActor = {
  actorType: "SYSTEM",
  actorId: "worker-document-test",
  label: "Document integration worker"
};
const temporaryDirectories: string[] = [];

function intake(name: string) {
  return {
    mode: "detailed" as const,
    name,
    clientName: "Document fixture client",
    coreQuestion: "Can durable document processing preserve citation provenance safely?",
    background: "Synthetic document integration fixture.",
    purpose: "Exercise quarantine, scanning, extraction, and citation anchors.",
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

async function storage(): Promise<LocalObjectStorage> {
  const root = await mkdtemp(path.join(tmpdir(), "research-documents-integration-"));
  temporaryDirectories.push(root);
  return new LocalObjectStorage({ root, defaultBucket: "private", maxReadBytes: 1_000_000 });
}

async function quarantineText(
  projectId: string,
  objectStorage: ObjectStorage,
  text = "Evidence paragraph one.\n\nEvidence paragraph two."
) {
  return quarantineDocument(
    {
      projectId,
      file: {
        filename: "evidence.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(text)
      },
      source: { title: "Synthetic uploaded evidence" },
      actor,
      maxBytes: 1_000_000,
      bucket: "private"
    },
    objectStorage
  );
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

afterAll(async () => {
  await closePool();
});

describe("durable document persistence", () => {
  it("refuses in-flight project work, then deletes after the worker drains", async () => {
    const project = await createProject(intake("Project deletion cleanup"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    const submitted = await submitJob({
      projectId: project.id,
      jobType: "DELETE_PROJECT_RUNNING_FIXTURE",
      inputReference: { synthetic: true },
      idempotencyKey: "delete-project-running-fixture"
    });
    const claimed = (
      await claimJobs({
        workerId: "delete-project-worker",
        limit: 1,
        leaseDurationMs: 30_000,
        jobTypes: ["DELETE_PROJECT_RUNNING_FIXTURE"]
      })
    )[0];
    await startJob(claimed.id, "delete-project-worker", claimed.version);

    await expect(
      deleteProject(project.id, {
        actorType: "USER",
        actorLabel: "Project deletion integration operator"
      })
    ).rejects.toMatchObject({ code: "PROJECT_JOBS_ACTIVE" });
    await expect(
      query<{ projects: number; retention_status: string }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM research_projects WHERE id = $1) AS projects,
          retention_status
         FROM storage_objects WHERE id = $2`,
        [project.id, quarantined.objectId]
      )
    ).resolves.toMatchObject({
      rows: [{ projects: 1, retention_status: "ACTIVE" }]
    });
    expect(await objectStorage.head(quarantined.location)).not.toBeNull();
    await completeJob({
      jobId: submitted.job.id,
      workerId: "delete-project-worker",
      outputReference: { drained: true }
    });

    const deleted = await deleteProject(project.id, {
      actorType: "USER",
      actorLabel: "Project deletion integration operator"
    });
    expect(deleted).toMatchObject({ cleanupJobId: expect.any(String), objectCount: 1 });
    await expect(
      query("SELECT id FROM research_projects WHERE id = $1", [project.id])
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(query("SELECT id FROM jobs WHERE id = $1", [submitted.job.id])).resolves.toMatchObject({
      rowCount: 0
    });
    await expect(
      query<{ input_reference: { objectIds: string[] } }>(
        "SELECT input_reference FROM jobs WHERE id = $1",
        [deleted.cleanupJobId]
      )
    ).resolves.toMatchObject({
      rows: [{ input_reference: { objectIds: [quarantined.objectId] } }]
    });
    await expect(
      query<{ project_id: string | null; retention_status: string }>(
        "SELECT project_id, retention_status FROM storage_objects WHERE id = $1",
        [quarantined.objectId]
      )
    ).resolves.toMatchObject({
      rows: [{ project_id: null, retention_status: "PENDING_DELETE" }]
    });
    await expect(
      query<{ action: string; project_id: string | null; pending: number }>(
        `SELECT action, project_id,
          (before_state ->> 'pendingObjectCount')::integer AS pending
         FROM audit_events
         WHERE resource_type = 'research_project' AND resource_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ action: "PROJECT_DELETED", project_id: null, pending: 1 }]
    });
    expect(await objectStorage.head(quarantined.location)).not.toBeNull();
    const cleanup = await cleanupOrphanObjects({
      storage: objectStorage,
      catalog: new PostgresStorageObjectCatalog(),
      bucket: "private",
      owner: "project-deletion-cleanup",
      leaseSeconds: 30,
      limit: 10
    });
    expect(cleanup.deletedTrackedIds).toContain(quarantined.objectId);
    expect(await objectStorage.head(quarantined.location)).toBeNull();
  });

  it("commits one document and object for concurrent idempotent upload retries", async () => {
    const project = await createProject(intake("Concurrent document upload"));
    const objectStorage = await storage();
    const upload = () =>
      quarantineDocument(
        {
          projectId: project.id,
          file: {
            filename: "idempotent-evidence.txt",
            mimeType: "text/plain",
            bytes: new TextEncoder().encode("One immutable synthetic upload.")
          },
          source: { title: "Idempotent upload fixture" },
          actor,
          idempotencyKey: "document-upload-concurrent-1",
          maxBytes: 1_000_000,
          bucket: "private"
        },
        objectStorage
      );

    const [first, second] = await Promise.all([upload(), upload()]);
    expect(second).toMatchObject({
      id: first.id,
      sourceId: first.sourceId,
      objectId: first.objectId,
      sha256: first.sha256
    });
    await expect(
      query<{ documents: number; sources: number; objects: number; audits: number }>(
        `SELECT
          (SELECT COUNT(*)::integer FROM documents WHERE project_id = $1) AS documents,
          (SELECT COUNT(*)::integer FROM sources WHERE project_id = $1) AS sources,
          (SELECT COUNT(*)::integer FROM storage_objects WHERE project_id = $1) AS objects,
          (SELECT COUNT(*)::integer FROM audit_events
            WHERE project_id = $1 AND action = 'DOCUMENT_QUARANTINED') AS audits`,
        [project.id]
      )
    ).resolves.toMatchObject({
      rows: [{ documents: 1, sources: 1, objects: 1, audits: 1 }]
    });
  });

  it("keeps a quarantined source unusable until a clean scan and atomic extraction commit", async () => {
    const project = await createProject(intake("Clean document workflow"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);

    const before = await query<{
      document_status: string;
      sanitized_content: string | null;
      scan_status: string;
    }>(
      "SELECT d.status AS document_status, s.sanitized_content, o.scan_status" +
        " FROM documents d JOIN sources s ON s.id = d.source_id" +
        " JOIN storage_objects o ON o.id = d.raw_object_id WHERE d.id = $1",
      [quarantined.id]
    );
    expect(before.rows[0]).toEqual({
      document_status: "QUARANTINED",
      sanitized_content: null,
      scan_status: "UNSCANNED"
    });

    const scanned = await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner(),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    expect(scanned.status).toBe("CLEAN");
    expect(scanned.cleanObjectId).toEqual(expect.any(String));
    await expect(
      query<{ storage_object_id: string; object_key: string; scan_status: string }>(
        `SELECT s.storage_object_id, o.object_key, o.scan_status
         FROM sources s
         JOIN storage_objects o ON o.id = s.storage_object_id
         WHERE s.id = $1`,
        [quarantined.sourceId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          storage_object_id: scanned.cleanObjectId,
          object_key: expect.stringMatching(/^sources\//),
          scan_status: "CLEAN"
        }
      ]
    });

    const extraction = await extractDocument(project.id, quarantined.id, objectStorage, {
      maxBytes: 1_000_000,
      actor: worker,
      chunking: { maxChars: 200, overlapChars: 20 }
    });
    expect(extraction).toMatchObject({ status: "READY", version: 1 });

    const persisted = await query<{
      status: string;
      sanitized_content: string | null;
      extraction_count: string;
      block_count: string;
      chunk_count: string;
      anchor_count: string;
    }>(
      "SELECT d.status, s.sanitized_content," +
        " (SELECT COUNT(*)::text FROM document_extractions x WHERE x.document_id = d.id) AS extraction_count," +
        " (SELECT COUNT(*)::text FROM document_blocks b JOIN document_extractions x ON x.id = b.extraction_id WHERE x.document_id = d.id) AS block_count," +
        " (SELECT COUNT(*)::text FROM document_chunks c JOIN document_extractions x ON x.id = c.extraction_id WHERE x.document_id = d.id) AS chunk_count," +
        " (SELECT COUNT(*)::text FROM citation_anchors a WHERE a.document_id = d.id) AS anchor_count" +
        " FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = $1",
      [quarantined.id]
    );
    expect(persisted.rows[0].status).toBe("READY");
    expect(persisted.rows[0].sanitized_content).toContain("Evidence paragraph one.");
    expect(persisted.rows[0].extraction_count).toBe("1");
    expect(Number(persisted.rows[0].block_count)).toBeGreaterThan(0);
    expect(Number(persisted.rows[0].chunk_count)).toBeGreaterThan(0);
    expect(persisted.rows[0].anchor_count).toBe(persisted.rows[0].chunk_count);
    const artifact = await query<{
      id: string;
      bucket: string;
      object_key: string;
      sha256: string;
      integrity_status: string;
    }>(
      `SELECT o.id, o.bucket, o.object_key, o.sha256, o.integrity_status
       FROM document_extractions x
       JOIN storage_objects o ON o.id = x.artifact_object_id
       WHERE x.id = $1`,
      [extraction.extractionId]
    );
    expect(artifact.rows[0]).toMatchObject({
      integrity_status: "VERIFIED",
      object_key: expect.stringMatching(/^extractions\//)
    });
    const artifactBytes = await objectStorage.read(
      {
        bucket: artifact.rows[0].bucket,
        key: artifact.rows[0].object_key
      },
      { maxBytes: 1_000_000, expectedSha256: artifact.rows[0].sha256 }
    );
    expect(JSON.parse(new TextDecoder().decode(artifactBytes))).toMatchObject({
      schemaVersion: "document-extraction-artifact.v1",
      projectId: project.id,
      documentId: quarantined.id,
      extractionId: extraction.extractionId,
      version: 1
    });
  });

  it("rejects infected input and never exposes it to extraction or source content", async () => {
    const project = await createProject(intake("Infected document workflow"));
    const objectStorage = await storage();
    const bytes = new TextEncoder().encode("harmless deterministic infected fixture");
    const quarantined = await quarantineDocument(
      {
        projectId: project.id,
        file: { filename: "fixture.txt", mimeType: "text/plain", bytes },
        actor,
        maxBytes: 1_000_000,
        bucket: "private"
      },
      objectStorage
    );
    const scan = await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner({ infectedSha256: new Set([sha256Hex(bytes)]) }),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    expect(scan.status).toBe("REJECTED");
    await expect(
      extractDocument(project.id, quarantined.id, objectStorage, {
        maxBytes: 1_000_000,
        actor: worker
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_SCAN_REQUIRED" });
    const source = await query<{ sanitized_content: string | null }>(
      "SELECT sanitized_content FROM sources WHERE id = $1",
      [quarantined.sourceId]
    );
    expect(source.rows[0].sanitized_content).toBeNull();
  });

  it("blocks production processing when the scanner is unavailable", async () => {
    const project = await createProject(intake("Unavailable scanner workflow"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    const scan = await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner({ result: "ERROR" }),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    expect(scan).toMatchObject({
      status: "BLOCKED_SCANNER_UNAVAILABLE",
      bypassed: false,
      scan: { status: "ERROR" }
    });
    const document = await query<{ status: string; scan_bypassed: boolean }>(
      "SELECT status, scan_bypassed FROM documents WHERE id = $1",
      [quarantined.id]
    );
    expect(document.rows[0]).toEqual({
      status: "BLOCKED_SCANNER_UNAVAILABLE",
      scan_bypassed: false
    });
    const demoScan = await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner({ result: "ERROR" }),
      {
        maxBytes: 1_000_000,
        production: false,
        allowExplicitDemoBypass: true,
        actor: worker
      }
    );
    expect(demoScan).toMatchObject({ status: "CLEAN", bypassed: true });
    await expect(
      extractDocument(project.id, quarantined.id, objectStorage, {
        maxBytes: 1_000_000,
        production: true,
        allowExplicitDemoBypass: true,
        actor: worker
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_SCAN_REQUIRED" });
    await expect(
      extractDocument(project.id, quarantined.id, objectStorage, {
        maxBytes: 1_000_000,
        production: false,
        allowExplicitDemoBypass: true,
        actor: worker
      })
    ).resolves.toMatchObject({ status: "READY" });
  });

  it("rolls back partial blocks and preserves an untracked retry artifact when persistence fails", async () => {
    const project = await createProject(intake("Extraction rollback workflow"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner(),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    await query(
      "CREATE OR REPLACE FUNCTION reject_document_block_fixture() RETURNS trigger" +
        " LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic block insert failure'; END $$"
    );
    await query(
      "CREATE TRIGGER reject_document_block_fixture_trigger BEFORE INSERT ON document_blocks" +
        " FOR EACH ROW EXECUTE FUNCTION reject_document_block_fixture()"
    );
    try {
      await expect(
        extractDocument(project.id, quarantined.id, objectStorage, {
          maxBytes: 1_000_000,
          actor: worker
        })
      ).rejects.toThrow("synthetic block insert failure");
    } finally {
      await query("DROP TRIGGER IF EXISTS reject_document_block_fixture_trigger ON document_blocks");
      await query("DROP FUNCTION IF EXISTS reject_document_block_fixture()") ;
    }
    const result = await query<{
      status: string;
      sanitized_content: string | null;
      failed: string;
      blocks: string;
      chunks: string;
      anchors: string;
    }>(
      "SELECT d.status, s.sanitized_content," +
        " (SELECT COUNT(*)::text FROM document_extractions x WHERE x.document_id = d.id AND x.status = 'FAILED') AS failed," +
        " (SELECT COUNT(*)::text FROM document_blocks b JOIN document_extractions x ON x.id = b.extraction_id WHERE x.document_id = d.id) AS blocks," +
        " (SELECT COUNT(*)::text FROM document_chunks c JOIN document_extractions x ON x.id = c.extraction_id WHERE x.document_id = d.id) AS chunks," +
        " (SELECT COUNT(*)::text FROM citation_anchors a WHERE a.document_id = d.id) AS anchors" +
        " FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = $1",
      [quarantined.id]
    );
    expect(result.rows[0]).toEqual({
      status: "EXTRACTION_FAILED",
      sanitized_content: null,
      failed: "1",
      blocks: "0",
      chunks: "0",
      anchors: "0"
    });
    const retained = await objectStorage.list("extractions");
    expect(retained).toHaveLength(1);
    const metadata = await objectStorage.head(retained[0].location);
    expect(metadata?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      objectStorage.read(retained[0].location, {
        maxBytes: 1_000_000,
        expectedSha256: metadata!.sha256
      })
    ).resolves.toHaveLength(metadata!.byteSize);
    await expect(
      query<{ cataloged: number }>(
        "SELECT COUNT(*)::integer AS cataloged FROM storage_objects WHERE provider = $1 AND bucket = $2 AND object_key = $3",
        [objectStorage.provider, retained[0].location.bucket, retained[0].location.key]
      )
    ).resolves.toMatchObject({ rows: [{ cataloged: 0 }] });
  });

  it("keeps prior anchors immutable and marks linked evidence for review on re-extraction", async () => {
    const project = await createProject(intake("Re-extraction workflow"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    await scanDocument(
      project.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner(),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    const first = await extractDocument(project.id, quarantined.id, objectStorage, {
      maxBytes: 1_000_000,
      actor: worker
    });
    const anchor = await query<{ id: string; chunk_id: string }>(
      "SELECT id, chunk_id FROM citation_anchors WHERE extraction_id = $1 LIMIT 1",
      [first.extractionId]
    );
    const evidence = await addEvidence({
      sourceId: quarantined.sourceId,
      summary: "Evidence linked to the first immutable extraction.",
      minimalQuote: "Evidence paragraph one.",
      originalLocation: "Uploaded document",
      confidence: "HIGH",
      verificationStatus: "VERIFIED"
    });
    await query(
      "UPDATE evidence SET document_id = $2, chunk_id = $3, citation_anchor_id = $4," +
        " citation_status = 'CURRENT' WHERE id = $1",
      [evidence.id, quarantined.id, anchor.rows[0].chunk_id, anchor.rows[0].id]
    );

    const second = await extractDocument(project.id, quarantined.id, objectStorage, {
      maxBytes: 1_000_000,
      actor: worker
    });
    expect(second.version).toBe(2);
    const statuses = await query<{ extraction_id: string; status: string }>(
      "SELECT extraction_id, status FROM citation_anchors WHERE document_id = $1 ORDER BY created_at",
      [quarantined.id]
    );
    expect(statuses.rows.some((row) => row.extraction_id === first.extractionId && row.status === "NEEDS_REVIEW")).toBe(true);
    expect(statuses.rows.some((row) => row.extraction_id === second.extractionId && row.status === "CURRENT")).toBe(true);
    const evidenceStatus = await query<{ citation_status: string }>(
      "SELECT citation_status FROM evidence WHERE id = $1",
      [evidence.id]
    );
    expect(evidenceStatus.rows[0].citation_status).toBe("NEEDS_REVIEW");
  });

  it("requires authentication, enforces project access, and defers physical deletion to cleanup", async () => {
    const firstProject = await createProject(intake("Document access project A"));
    const secondProject = await createProject(intake("Document access project B"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(firstProject.id, objectStorage);
    const scanned = await scanDocument(
      firstProject.id,
      quarantined.id,
      objectStorage,
      new MockMalwareScanner(),
      { maxBytes: 1_000_000, production: true, actor: worker }
    );
    await expect(
      readDocumentObject(firstProject.id, quarantined.id, objectStorage, null, 1_000_000)
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(
      readDocumentObject(secondProject.id, quarantined.id, objectStorage, actor, 1_000_000)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteDocument(secondProject.id, quarantined.id, actor)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    const downloaded = await readDocumentObject(
      firstProject.id,
      quarantined.id,
      objectStorage,
      actor,
      1_000_000
    );
    expect(new TextDecoder().decode(downloaded.bytes)).toContain("Evidence paragraph one.");

    const queuedExtraction = await submitJob({
      projectId: firstProject.id,
      jobType: "DOCUMENT_EXTRACT",
      inputReference: { documentId: quarantined.id },
      idempotencyKey: `queued-document-delete:${quarantined.id}`
    });
    await deleteDocument(firstProject.id, quarantined.id, actor);
    await expect(
      query<{ status: string; events: number }>(
        `SELECT status,
          (SELECT COUNT(*)::integer FROM job_events
            WHERE job_id = $1 AND event_type = 'JOB_CANCELLATION_REQUESTED') AS events
         FROM jobs WHERE id = $1`,
        [queuedExtraction.job.id]
      )
    ).resolves.toMatchObject({ rows: [{ status: "CANCELLED", events: 1 }] });
    expect(await objectStorage.head(quarantined.location)).not.toBeNull();
    const cleanup = await cleanupOrphanObjects({
      storage: objectStorage,
      catalog: new PostgresStorageObjectCatalog(),
      bucket: "private",
      owner: "document-integration-cleanup",
      leaseSeconds: 30,
      limit: 10
    });
    expect([...cleanup.deletedTrackedIds].sort()).toEqual(
      [quarantined.objectId, scanned.cleanObjectId!].sort()
    );
    expect(await objectStorage.head(quarantined.location)).toBeNull();
    const object = await query<{ retention_status: string; upload_status: string }>(
      "SELECT retention_status, upload_status FROM storage_objects WHERE id = $1",
      [quarantined.objectId]
    );
    expect(object.rows[0]).toEqual({ retention_status: "DELETED", upload_status: "DELETED" });
  });

  it("rolls back document deletion when its targeted cleanup job cannot commit", async () => {
    const project = await createProject(intake("Document cleanup submission rollback"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    const conflictingCleanup = await submitJob({
      projectId: project.id,
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, objectIds: ["different-object"] },
      idempotencyKey: `document-delete:${quarantined.id}:storage-cleanup`
    });
    await requestJobCancellation(conflictingCleanup.job.id, "Document rollback fixture");

    await expect(deleteDocument(project.id, quarantined.id, actor)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED"
    });
    await expect(
      query<{ document_status: string; retention_status: string; audits: number }>(
        `SELECT d.status AS document_status, o.retention_status,
          (SELECT COUNT(*)::integer FROM audit_events
            WHERE project_id = $1 AND action = 'DOCUMENT_DELETE_REQUESTED') AS audits
         FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id
         WHERE d.id = $2`,
        [project.id, quarantined.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          document_status: "QUARANTINED",
          retention_status: "ACTIVE",
          audits: 0
        }
      ]
    });
    expect(await objectStorage.head(quarantined.location)).not.toBeNull();
  });

  it("refuses deletion while a scanner has written uncataloged bytes, then targets them after drain", async () => {
    const project = await createProject(intake("Document processor deletion fence"));
    const objectStorage = await storage();
    const quarantined = await quarantineText(project.id, objectStorage);
    let announceLateWrite!: () => void;
    let releaseLateWrite!: () => void;
    const lateWriteEntered = new Promise<void>((resolve) => {
      announceLateWrite = resolve;
    });
    const lateWriteReleased = new Promise<void>((resolve) => {
      releaseLateWrite = resolve;
    });
    const pausingStorage: ObjectStorage = {
      provider: objectStorage.provider,
      put: async (input) => {
        const stored = await objectStorage.put(input);
        if (input.location.key.startsWith("sources/")) {
          announceLateWrite();
          await lateWriteReleased;
        }
        return stored;
      },
      read: objectStorage.read.bind(objectStorage),
      head: objectStorage.head.bind(objectStorage),
      delete: objectStorage.delete.bind(objectStorage),
      list: objectStorage.list.bind(objectStorage),
      createDownloadUrl: objectStorage.createDownloadUrl.bind(objectStorage)
    };
    const processing = await submitJob({
      projectId: project.id,
      jobType: "DOCUMENT_SCAN",
      inputReference: {
        documentId: quarantined.id,
        expectedObjectSha256: quarantined.sha256,
        autoExtract: false
      },
      idempotencyKey: `document-scan-delete-fence:${quarantined.id}`
    });
    const claimed = (
      await claimJobs({
        workerId: "document-delete-fence-worker",
        limit: 1,
        leaseDurationMs: 30_000,
        jobTypes: ["DOCUMENT_SCAN"]
      })
    )[0];
    const started = await startJob(
      claimed.id,
      "document-delete-fence-worker",
      claimed.version
    );
    const scanPromise = scanDocument(
      project.id,
      quarantined.id,
      pausingStorage,
      new MockMalwareScanner(),
      {
        maxBytes: 1_000_000,
        production: true,
        actor: worker,
        jobFence: {
          jobId: started.id,
          workerId: "document-delete-fence-worker",
          attempt: started.attempts,
          version: started.version
        }
      }
    );
    await lateWriteEntered;

    let assertionError: unknown;
    try {
      await expect(deleteDocument(project.id, quarantined.id, actor)).rejects.toMatchObject({
        code: "DOCUMENT_JOBS_ACTIVE"
      });
      await expect(
        query<{ document_status: string; retention_status: string; cleanup_jobs: number }>(
          `SELECT d.status AS document_status, o.retention_status,
            (SELECT COUNT(*)::integer FROM jobs
              WHERE project_id = $1 AND job_type = 'STORAGE_CLEANUP') AS cleanup_jobs
           FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id
           WHERE d.id = $2`,
          [project.id, quarantined.id]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            document_status: "SCANNING",
            retention_status: "ACTIVE",
            cleanup_jobs: 0
          }
        ]
      });
      expect(
        (await objectStorage.list()).filter((object) =>
          object.location.key.startsWith("sources/")
        )
      ).toHaveLength(1);
      await expect(
        query("SELECT id FROM storage_objects WHERE project_id = $1 AND object_key LIKE 'sources/%'", [
          project.id
        ])
      ).resolves.toMatchObject({ rowCount: 0 });
    } catch (error) {
      assertionError = error;
    } finally {
      releaseLateWrite();
    }

    const scanned = await scanPromise;
    if (assertionError) throw assertionError;
    await completeJob({
      jobId: processing.job.id,
      workerId: "document-delete-fence-worker",
      outputReference: { drained: true }
    });
    const deletion = await deleteDocument(project.id, quarantined.id, actor);
    expect(deletion).toMatchObject({
      objectIds: [quarantined.objectId, scanned.cleanObjectId].sort(),
      cleanupJobId: expect.any(String),
      cleanupStatus: "PENDING_DELETE"
    });
  });

  it.each(["RESEARCH_PIPELINE_STAGE", "GENERATE_EXPORT"])(
    "refuses document deletion while %s project work is queued or running",
    async (jobType) => {
      const project = await createProject(intake(`Document ${jobType} deletion fence`));
      const objectStorage = await storage();
      const quarantined = await quarantineText(project.id, objectStorage);
      const processing = await submitJob({
        projectId: project.id,
        jobType,
        inputReference: { synthetic: true },
        idempotencyKey: `document-project-job-fence:${jobType}`
      });
      await expect(deleteDocument(project.id, quarantined.id, actor)).rejects.toMatchObject({
        code: "DOCUMENT_JOBS_ACTIVE"
      });
      const workerId = `document-project-job-fence-${jobType.toLowerCase()}`;
      const claimed = (
        await claimJobs({
          workerId,
          limit: 1,
          leaseDurationMs: 30_000,
          jobTypes: [jobType]
        })
      )[0];
      await startJob(claimed.id, workerId, claimed.version);

      await expect(deleteDocument(project.id, quarantined.id, actor)).rejects.toMatchObject({
        code: "DOCUMENT_JOBS_ACTIVE"
      });
      expect(await objectStorage.head(quarantined.location)).not.toBeNull();
      await expect(
        query<{ status: string; retention_status: string }>(
          `SELECT d.status, o.retention_status
           FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id
           WHERE d.id = $1`,
          [quarantined.id]
        )
      ).resolves.toMatchObject({
        rows: [{ status: "QUARANTINED", retention_status: "ACTIVE" }]
      });

      await completeJob({
        jobId: processing.job.id,
        workerId,
        outputReference: { drained: true }
      });
      await expect(deleteDocument(project.id, quarantined.id, actor)).resolves.toMatchObject({
        cleanupJobId: expect.any(String)
      });
    }
  );

  it("deletes an untracked object when the metadata transaction loses its project", async () => {
    const project = await createProject(intake("Quarantine compensation workflow"));
    const local = await storage();
    const destructiveWrapper: ObjectStorage = {
      provider: local.provider,
      put: async (input) => {
        const stored = await local.put(input);
        await query("DELETE FROM research_projects WHERE id = $1", [project.id]);
        return stored;
      },
      read: (location, options) => local.read(location, options),
      head: (location) => local.head(location),
      delete: (location) => local.delete(location),
      list: (prefix) => local.list(prefix),
      createDownloadUrl: () => local.createDownloadUrl()
    };
    await expect(quarantineText(project.id, destructiveWrapper)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(await local.list()).toEqual([]);
    expect((await query("SELECT id FROM storage_objects")).rowCount).toBe(0);
  });
});
