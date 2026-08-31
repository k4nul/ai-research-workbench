import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  assertDocumentTransition,
  chunkExtraction,
  extractDocxDocument,
  extractHtmlDocument,
  extractPdfDocument,
  extractTextDocument,
  resolveScanDisposition,
  type DocumentExtractionResult,
  type DocumentStatus,
  type ExtractableDocumentFormat,
  type ExtractionLimits,
  type MalwareScanner,
  type MalwareScanResult
} from "@/lib/documents";
import { assessPromptInjection } from "@/lib/security/content";
import { FileValidationError, validateUploadedFile } from "@/lib/security/files";
import {
  createObjectKey,
  StorageError,
  sha256Hex,
  type ObjectStorage,
  type StorageLocation,
  type StorageProviderKind
} from "@/lib/storage";
import { query, withTransaction } from "@/lib/db";
import { assessSourceFreshness } from "@/lib/domain/research";
import { sourceInputSchema } from "@/lib/validation";
import { writeAuditEvent } from "./audit";
import { AppError, conflict, notFound } from "./errors";
import {
  requestJobCancellationInTransaction,
  submitJobInTransaction
} from "./jobs";
import { invalidateDownstreamReview } from "./review-state";

export interface DocumentActor {
  actorType: "USER" | "SYSTEM";
  actorId: string;
  label: string;
}

export interface DocumentJobFence {
  jobId: string;
  workerId: string;
  attempt: number;
  version: string;
}

export interface UploadedDocumentSourceInput {
  title?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  sourceType?: string;
  language?: string;
  reliabilityGrade?: "A" | "B" | "C" | "D" | "UNRATED";
  usageRestrictions?: string;
}

export interface QuarantineDocumentInput {
  projectId: string;
  file: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  };
  source?: UploadedDocumentSourceInput;
  actor: DocumentActor;
  idempotencyKey?: string;
  maxBytes: number;
  bucket?: string;
}

export interface QuarantinedDocument {
  id: string;
  projectId: string;
  sourceId: string;
  objectId: string;
  status: DocumentStatus;
  location: StorageLocation;
  sha256: string;
  byteSize: number;
}

interface ExistingDocumentUpload {
  id: string;
  project_id: string;
  source_id: string;
  raw_object_id: string;
  status: DocumentStatus;
  upload_input_hash: string;
  provider: StorageProviderKind;
  bucket: string;
  object_key: string;
  sha256: string;
  byte_size: string;
  upload_status: string;
  retention_status: string;
}

function deterministicUploadUuid(projectId: string, key: string, resource: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`${projectId}\0${key}\0${resource}`).digest("hex").slice(0, 32),
    "hex"
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function existingDocumentUpload(
  projectId: string,
  idempotencyKey: string,
  inputHash: string,
  storage: ObjectStorage,
  maxBytes: number
): Promise<QuarantinedDocument | null> {
  const result = await query<ExistingDocumentUpload>(
    `SELECT d.id, d.project_id, d.source_id, d.raw_object_id, d.status,
      d.upload_input_hash, o.provider, o.bucket, o.object_key, o.sha256,
      o.byte_size::text, o.upload_status, o.retention_status
     FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id
     WHERE d.project_id = $1 AND d.upload_idempotency_key = $2`,
    [projectId, idempotencyKey]
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.upload_input_hash !== inputHash) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The document upload idempotency key was already used for different input."
    );
  }
  if (
    existing.upload_status !== "AVAILABLE" ||
    existing.retention_status !== "ACTIVE" ||
    existing.status === "DELETED"
  ) {
    throw conflict(
      "DOCUMENT_UPLOAD_NOT_REUSABLE",
      "The prior document upload is no longer an active reusable object."
    );
  }
  ensureStorageProvider(storage, existing.provider);
  await storage.read(
    { bucket: existing.bucket, key: existing.object_key },
    { maxBytes, expectedSha256: existing.sha256 }
  );
  return {
    id: existing.id,
    projectId: existing.project_id,
    sourceId: existing.source_id,
    objectId: existing.raw_object_id,
    status: existing.status,
    location: { bucket: existing.bucket, key: existing.object_key },
    sha256: existing.sha256,
    byteSize: Number(existing.byte_size)
  };
}

async function readIdempotentUploadObject(
  storage: ObjectStorage,
  location: StorageLocation,
  maxBytes: number,
  expectedSha256: string
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await storage.read(location, { maxBytes, expectedSha256 });
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof StorageError) ||
        !["OBJECT_NOT_FOUND", "INTEGRITY_MISMATCH"].includes(error.code)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw conflict(
    "IDEMPOTENCY_KEY_REUSED",
    "The document upload idempotency key already identifies different stored bytes.",
    { storageError: safeInternalError(lastError) }
  );
}

interface LockedDocument {
  id: string;
  project_id: string;
  source_id: string | null;
  raw_object_id: string;
  status: DocumentStatus;
  scan_bypassed: boolean;
  current_extraction_id: string | null;
  provider: StorageProviderKind;
  bucket: string;
  object_key: string;
  content_type: string;
  original_filename: string | null;
  sanitized_filename: string | null;
  byte_size: string | null;
  sha256: string | null;
  integrity_status: string;
  upload_status: string;
  scan_status: MalwareScanResult["status"];
  retention_status: string;
}

function assertActor(actor: DocumentActor | null | undefined): asserts actor is DocumentActor {
  if (!actor?.actorId.trim() || !actor.label.trim()) {
    throw new AppError(401, "AUTH_REQUIRED", "An authenticated operator is required.");
  }
}

function assertAuthenticatedOperator(
  actor: DocumentActor | null | undefined
): asserts actor is DocumentActor {
  assertActor(actor);
  if (actor.actorType !== "USER") {
    throw new AppError(403, "OPERATOR_REQUIRED", "An authenticated operator is required.");
  }
}

function safeInternalError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown document processing failure.";
  return error.message.replace(/[\0\r\n]+/g, " ").trim().slice(0, 500);
}

function ensureStorageProvider(storage: ObjectStorage, provider: StorageProviderKind): void {
  if (storage.provider !== provider) {
    throw new AppError(
      503,
      "STORAGE_PROVIDER_MISMATCH",
      "The document storage provider is not available."
    );
  }
}

function objectLocation(document: LockedDocument): StorageLocation {
  return { bucket: document.bucket, key: document.object_key };
}

async function lockProject(client: PoolClient, projectId: string): Promise<void> {
  const project = await client.query("SELECT id FROM research_projects WHERE id = $1 FOR UPDATE", [
    projectId
  ]);
  if (!project.rowCount) throw notFound("Project");
}

async function lockDocument(
  client: PoolClient,
  projectId: string,
  documentId: string
): Promise<LockedDocument> {
  await lockProject(client, projectId);
  const result = await client.query<LockedDocument>(
    "SELECT d.id, d.project_id, d.source_id, d.raw_object_id, d.status, d.scan_bypassed," +
      " d.current_extraction_id, o.provider, o.bucket, o.object_key, o.content_type," +
      " o.original_filename, o.sanitized_filename, o.byte_size::text, o.sha256," +
      " o.integrity_status, o.upload_status, o.scan_status, o.retention_status" +
      " FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id" +
      " WHERE d.id = $1 AND d.project_id = $2 FOR UPDATE OF d, o",
    [documentId, projectId]
  );
  if (!result.rows[0]) throw notFound("Document");
  return result.rows[0];
}

export async function assertDocumentJobFence(
  client: PoolClient,
  projectId: string,
  documentId: string,
  jobType: "DOCUMENT_SCAN" | "DOCUMENT_EXTRACT",
  fence?: DocumentJobFence
): Promise<void> {
  if (!fence) return;
  const current = await client.query(
    `SELECT id FROM jobs
      WHERE id = $1
        AND project_id = $2
        AND job_type = $3
        AND input_reference ->> 'documentId' = $4
        AND status = 'RUNNING'
        AND lease_owner = $5
        AND attempts = $6
        AND version >= $7::bigint
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE`,
    [
      fence.jobId,
      projectId,
      jobType,
      documentId,
      fence.workerId,
      fence.attempt,
      fence.version
    ]
  );
  if (!current.rowCount) {
    throw conflict(
      "JOB_LEASE_LOST",
      "The document worker no longer owns the current job attempt."
    );
  }
}

function isJobLeaseLost(error: unknown): boolean {
  return error instanceof AppError && error.code === "JOB_LEASE_LOST";
}

function formatFor(document: LockedDocument): ExtractableDocumentFormat {
  const mime = document.content_type.split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf") return "PDF";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "DOCX";
  }
  if (
    mime === "application/json" ||
    mime === "text/csv" ||
    mime === "text/markdown" ||
    mime === "text/plain"
  ) {
    return "TXT";
  }
  if (mime === "text/html") return "HTML";
  throw new AppError(422, "UNSUPPORTED_DOCUMENT_FORMAT", "Document format is not extractable.");
}

function scopedBlockId(extractionId: string, stableAnchor: string): string {
  const digest = createHash("sha256")
    .update(`${extractionId}\0${stableAnchor}`)
    .digest("hex")
    .slice(0, 40);
  return `block-${digest}`;
}

function scopedChunkId(extractionId: string, stableChunkId: string): string {
  const digest = createHash("sha256")
    .update(`${extractionId}\0${stableChunkId}`)
    .digest("hex")
    .slice(0, 40);
  return `chunk-row-${digest}`;
}

type PreparedExtractionArtifact = {
  id: string;
  location: StorageLocation;
  byteSize: number;
  sha256: string;
  filename: string;
};

type PreparedCleanSourceObject = {
  id: string;
  location: StorageLocation;
  byteSize: number;
  sha256: string;
};

async function prepareCleanSourceObject(input: {
  projectId: string;
  document: LockedDocument;
  storage: ObjectStorage;
  bytes: Uint8Array;
  maxBytes: number;
}): Promise<PreparedCleanSourceObject> {
  const id = deterministicUploadUuid(
    input.projectId,
    input.document.raw_object_id,
    "clean-source-object"
  );
  const sha256 = sha256Hex(input.bytes);
  if (
    input.bytes.byteLength > input.maxBytes ||
    sha256 !== input.document.sha256 ||
    input.bytes.byteLength !== Number(input.document.byte_size)
  ) {
    throw new StorageError(
      "INTEGRITY_MISMATCH",
      "Clean source promotion does not match the quarantined object."
    );
  }
  const location = {
    bucket: input.document.bucket,
    key: createObjectKey("sources", id)
  };
  try {
    await input.storage.put({
      location,
      bytes: input.bytes,
      contentType: input.document.content_type,
      expectedByteSize: input.bytes.byteLength,
      expectedSha256: sha256,
      metadata: {
        artifact: "clean-source",
        rawobject: input.document.raw_object_id
      }
    });
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "OBJECT_EXISTS")) {
      throw error;
    }
    await input.storage.read(location, {
      maxBytes: input.maxBytes,
      expectedSha256: sha256
    });
  }
  return {
    id,
    location,
    byteSize: input.bytes.byteLength,
    sha256
  };
}

async function catalogCleanSourceObject(
  client: PoolClient,
  clean: PreparedCleanSourceObject,
  document: LockedDocument,
  actor: DocumentActor
): Promise<void> {
  await client.query(
    `INSERT INTO storage_objects (
       id, provider, bucket, object_key, content_type, original_filename,
       sanitized_filename, byte_size, sha256, integrity_status, upload_status,
       scan_status, extraction_status, retention_status, project_id, source_id,
       created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'VERIFIED', 'AVAILABLE',
       'CLEAN', 'NOT_REQUESTED', 'ACTIVE', $10, $11, $12
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      clean.id,
      document.provider,
      clean.location.bucket,
      clean.location.key,
      document.content_type,
      document.original_filename,
      document.sanitized_filename,
      clean.byteSize,
      clean.sha256,
      document.project_id,
      document.source_id,
      `${actor.actorType}:${actor.actorId}`
    ]
  );
  const stored = await client.query<{
    provider: StorageProviderKind;
    bucket: string;
    object_key: string;
    byte_size: string | null;
    sha256: string | null;
    scan_status: string;
    retention_status: string;
  }>(
    `SELECT provider, bucket, object_key, byte_size::text, sha256, scan_status,
            retention_status
     FROM storage_objects WHERE id = $1 FOR UPDATE`,
    [clean.id]
  );
  const row = stored.rows[0];
  if (
    !row ||
    row.provider !== document.provider ||
    row.bucket !== clean.location.bucket ||
    row.object_key !== clean.location.key ||
    Number(row.byte_size) !== clean.byteSize ||
    row.sha256 !== clean.sha256 ||
    row.scan_status !== "CLEAN" ||
    row.retention_status !== "ACTIVE"
  ) {
    throw conflict(
      "CLEAN_SOURCE_OBJECT_CONFLICT",
      "The clean source object identity conflicts with stored metadata."
    );
  }
}

async function prepareExtractionArtifact(input: {
  projectId: string;
  extractionId: string;
  document: LockedDocument;
  storage: ObjectStorage;
  payload: unknown;
  maxBytes: number;
}): Promise<PreparedExtractionArtifact> {
  const id = deterministicUploadUuid(
    input.projectId,
    input.extractionId,
    "extraction-artifact"
  );
  const bytes = new TextEncoder().encode(JSON.stringify(input.payload));
  if (bytes.byteLength > input.maxBytes) {
    throw new StorageError(
      "OBJECT_TOO_LARGE",
      "Generated extraction artifact exceeds the configured storage limit."
    );
  }
  const sha256 = sha256Hex(bytes);
  const location = {
    bucket: input.document.bucket,
    key: createObjectKey("extractions", id)
  };
  try {
    await input.storage.put({
      location,
      bytes,
      contentType: "application/json",
      expectedByteSize: bytes.byteLength,
      expectedSha256: sha256,
      metadata: {
        artifact: "document-extraction",
        extraction: input.extractionId
      }
    });
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "OBJECT_EXISTS")) {
      throw error;
    }
    await input.storage.read(location, {
      maxBytes: input.maxBytes,
      expectedSha256: sha256
    });
  }
  return {
    id,
    location,
    byteSize: bytes.byteLength,
    sha256,
    filename: `extraction-${input.extractionId}.json`
  };
}

async function catalogExtractionArtifact(
  client: PoolClient,
  artifact: PreparedExtractionArtifact,
  document: LockedDocument,
  actor: DocumentActor
): Promise<void> {
  await client.query(
    `INSERT INTO storage_objects (
       id, provider, bucket, object_key, content_type, original_filename,
       sanitized_filename, byte_size, sha256, integrity_status, upload_status,
       retention_status, project_id, source_id, created_by
     ) VALUES (
       $1, $2, $3, $4, 'application/json', $5, $5, $6, $7,
       'VERIFIED', 'AVAILABLE', 'ACTIVE', $8, $9, $10
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      artifact.id,
      document.provider,
      artifact.location.bucket,
      artifact.location.key,
      artifact.filename,
      artifact.byteSize,
      artifact.sha256,
      document.project_id,
      document.source_id,
      `${actor.actorType}:${actor.actorId}`
    ]
  );
  const stored = await client.query<{
    provider: StorageProviderKind;
    bucket: string;
    object_key: string;
    byte_size: string | null;
    sha256: string | null;
    retention_status: string;
  }>(
    `SELECT provider, bucket, object_key, byte_size::text, sha256, retention_status
     FROM storage_objects WHERE id = $1 FOR UPDATE`,
    [artifact.id]
  );
  const row = stored.rows[0];
  if (
    !row ||
    row.provider !== document.provider ||
    row.bucket !== artifact.location.bucket ||
    row.object_key !== artifact.location.key ||
    Number(row.byte_size) !== artifact.byteSize ||
    row.sha256 !== artifact.sha256 ||
    row.retention_status !== "ACTIVE"
  ) {
    throw conflict(
      "EXTRACTION_ARTIFACT_CONFLICT",
      "The generated extraction artifact metadata conflicts with stored state."
    );
  }
}

function validateExtractionResult(
  result: DocumentExtractionResult,
  format: ExtractableDocumentFormat,
  objectSha256: string,
  maxTextChars: number
): void {
  if (result.format !== format || result.documentHash !== objectSha256) {
    throw new Error("Extractor result does not match the stored document.");
  }
  if (result.status === "OCR_REQUIRED_UNSUPPORTED") {
    if (format !== "PDF" || result.blocks.length !== 0 || result.text !== "") {
      throw new Error("OCR-required result is inconsistent.");
    }
    return;
  }
  if (!result.contentHash || result.contentHash !== sha256Hex(new TextEncoder().encode(result.text))) {
    throw new Error("Extractor content hash is invalid.");
  }
  if (result.text.length > maxTextChars || result.blocks.length === 0) {
    throw new Error("Extractor result exceeds the usable content boundary.");
  }
  const anchors = new Set<string>();
  let previousEnd = -1;
  for (const block of result.blocks) {
    if (
      !block.text ||
      block.endOffset < block.startOffset ||
      block.startOffset < previousEnd ||
      block.contentHash !== sha256Hex(new TextEncoder().encode(block.text)) ||
      anchors.has(block.stableAnchor)
    ) {
      throw new Error("Extractor block provenance is invalid.");
    }
    anchors.add(block.stableAnchor);
    previousEnd = block.endOffset;
  }
}

async function builtinExtract(
  format: ExtractableDocumentFormat,
  bytes: Uint8Array,
  limits: Partial<ExtractionLimits>
): Promise<DocumentExtractionResult> {
  switch (format) {
    case "PDF":
      return extractPdfDocument(bytes, limits);
    case "DOCX":
      return extractDocxDocument(bytes, limits);
    case "TXT":
      return extractTextDocument(bytes, limits);
    case "HTML":
      return extractHtmlDocument(bytes, limits);
  }
}

export async function quarantineDocument(
  input: QuarantineDocumentInput,
  storage: ObjectStorage
): Promise<QuarantinedDocument> {
  assertActor(input.actor);
  let validated;
  try {
    validated = validateUploadedFile(
      {
        filename: input.file.filename,
        mimeType: input.file.mimeType,
        size: input.file.bytes.byteLength,
        bytes: input.file.bytes
      },
      { maxBytes: input.maxBytes }
    );
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw new AppError(422, error.code, error.message);
    }
    throw error;
  }
  if (
    ![
      ".csv",
      ".docx",
      ".htm",
      ".html",
      ".json",
      ".md",
      ".pdf",
      ".txt"
    ].includes(validated.extension)
  ) {
    throw new AppError(
      422,
      "UNSUPPORTED_DOCUMENT_FORMAT",
      "The durable document pipeline supports PDF, DOCX, TXT, HTML, Markdown, CSV, and JSON."
    );
  }
  const sourceInput = sourceInputSchema.parse({
    title: input.source?.title ?? validated.safeFilename,
    publisher: input.source?.publisher,
    author: input.source?.author,
    publishedAt: input.source?.publishedAt,
    sourceType: input.source?.sourceType ?? "UPLOAD",
    language: input.source?.language ?? "en",
    reliabilityGrade: input.source?.reliabilityGrade ?? "UNRATED",
    usageRestrictions: input.source?.usageRestrictions,
    ingestionMethod: "UPLOAD",
    mimeType: validated.mimeType
  });
  const sha256 = sha256Hex(input.file.bytes);
  const uploadInputHash = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        sha256,
        originalFilename: validated.originalFilename,
        safeFilename: validated.safeFilename,
        mimeType: validated.mimeType,
        source: sourceInput
      })
    )
    .digest("hex");
  if (input.idempotencyKey) {
    const replay = await existingDocumentUpload(
      input.projectId,
      input.idempotencyKey,
      uploadInputHash,
      storage,
      input.maxBytes
    );
    if (replay) return replay;
  }
  const preflight = await query("SELECT id FROM research_projects WHERE id = $1", [input.projectId]);
  if (!preflight.rowCount) throw notFound("Project");

  const objectId = input.idempotencyKey
    ? deterministicUploadUuid(input.projectId, input.idempotencyKey, "object")
    : randomUUID();
  const documentId = input.idempotencyKey
    ? deterministicUploadUuid(input.projectId, input.idempotencyKey, "document")
    : randomUUID();
  const sourceId = input.idempotencyKey
    ? deterministicUploadUuid(input.projectId, input.idempotencyKey, "source")
    : randomUUID();
  const location = {
    bucket: input.bucket,
    key: createObjectKey("quarantine", objectId)
  };
  let createdObject = true;
  let stored;
  try {
    stored = await storage.put({
      location,
      bytes: input.file.bytes,
      contentType: validated.mimeType,
      expectedByteSize: input.file.bytes.byteLength,
      expectedSha256: sha256
    });
  } catch (error) {
    if (!(input.idempotencyKey && error instanceof StorageError && error.code === "OBJECT_EXISTS")) {
      throw error;
    }
    createdObject = false;
    const bytes = await readIdempotentUploadObject(
      storage,
      location,
      input.maxBytes,
      sha256
    );
    stored = {
      location,
      byteSize: bytes.byteLength,
      sha256,
      contentType: validated.mimeType
    };
  }
  const bucket = stored.location.bucket;
  if (!bucket || stored.sha256 !== sha256 || stored.byteSize !== input.file.bytes.byteLength) {
    await storage.delete(stored.location).catch(() => undefined);
    throw new AppError(503, "STORAGE_INTEGRITY_FAILED", "Stored upload failed integrity checks.");
  }

  let transactionReplay: QuarantinedDocument | null = null;
  try {
    await withTransaction(async (client) => {
      const project = await client.query<{
        research_date: string;
        source_max_age_days: number;
      }>(
        "SELECT research_date::text, source_max_age_days FROM research_projects WHERE id = $1 FOR UPDATE",
        [input.projectId]
      );
      if (!project.rows[0]) throw notFound("Project");
      if (input.idempotencyKey) {
        const existing = await client.query<ExistingDocumentUpload>(
          `SELECT d.id, d.project_id, d.source_id, d.raw_object_id, d.status,
            d.upload_input_hash, o.provider, o.bucket, o.object_key, o.sha256,
            o.byte_size::text, o.upload_status, o.retention_status
           FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id
           WHERE d.project_id = $1 AND d.upload_idempotency_key = $2`,
          [input.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].upload_input_hash !== uploadInputHash) {
            throw conflict(
              "IDEMPOTENCY_KEY_REUSED",
              "The document upload idempotency key was already used for different input."
            );
          }
          transactionReplay = {
            id: existing.rows[0].id,
            projectId: existing.rows[0].project_id,
            sourceId: existing.rows[0].source_id,
            objectId: existing.rows[0].raw_object_id,
            status: existing.rows[0].status,
            location: {
              bucket: existing.rows[0].bucket,
              key: existing.rows[0].object_key
            },
            sha256: existing.rows[0].sha256,
            byteSize: Number(existing.rows[0].byte_size)
          };
          return;
        }
      }
      const freshness = assessSourceFreshness({
        publishedAt: sourceInput.publishedAt,
        researchDate: project.rows[0].research_date,
        maxAgeDays: project.rows[0].source_max_age_days
      });
      await client.query(
        "INSERT INTO storage_objects (id, provider, bucket, object_key, content_type," +
          " original_filename, sanitized_filename, byte_size, sha256, integrity_status," +
          " upload_status, scan_status, extraction_status, retention_status, project_id, created_by)" +
          " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'VERIFIED', 'AVAILABLE'," +
          " 'UNSCANNED', 'NOT_REQUESTED', 'ACTIVE', $10, $11)",
        [
          objectId,
          storage.provider,
          bucket,
          stored.location.key,
          validated.mimeType,
          validated.originalFilename,
          validated.safeFilename,
          stored.byteSize,
          stored.sha256,
          input.projectId,
          input.actor.actorId
        ]
      );
      await client.query(
        "INSERT INTO sources (id, project_id, title, publisher, author, published_at," +
          " source_type, language, original_status, reliability_grade, freshness_status," +
          " usage_restrictions, ingestion_method, mime_type, content_summary, sanitized_content," +
          " prompt_injection_flag, fetch_metadata, storage_object_id)" +
          " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UPLOAD', $9, $10, $11, 'UPLOAD'," +
          " $12, 'Quarantined upload awaiting malware scan and extraction.', NULL, FALSE," +
          " $13::jsonb, $14)",
        [
          sourceId,
          input.projectId,
          sourceInput.title,
          sourceInput.publisher ?? null,
          sourceInput.author ?? null,
          sourceInput.publishedAt ?? null,
          sourceInput.sourceType,
          sourceInput.language,
          sourceInput.reliabilityGrade,
          freshness,
          sourceInput.usageRestrictions ?? null,
          validated.mimeType,
          JSON.stringify({
            originalFilename: validated.originalFilename,
            safeFilename: validated.safeFilename,
            storageObjectId: objectId,
            documentId,
            size: stored.byteSize,
            sha256,
            documentStatus: "QUARANTINED"
          }),
          objectId
        ]
      );
      await client.query("UPDATE storage_objects SET source_id = $2 WHERE id = $1", [
        objectId,
        sourceId
      ]);
      await client.query(
        "INSERT INTO documents (id, project_id, source_id, raw_object_id, status, created_by," +
          " upload_idempotency_key, upload_input_hash)" +
          " VALUES ($1, $2, $3, $4, 'QUARANTINED', $5, $6, $7)",
        [
          documentId,
          input.projectId,
          sourceId,
          objectId,
          input.actor.actorId,
          input.idempotencyKey ?? null,
          input.idempotencyKey ? uploadInputHash : null
        ]
      );
      await invalidateDownstreamReview(client, input.projectId, "RESEARCHING");
      await writeAuditEvent(client, {
        projectId: input.projectId,
        actorType: input.actor.actorType,
        actorLabel: input.actor.label,
        action: "DOCUMENT_QUARANTINED",
        resourceType: "document",
        resourceId: documentId,
        afterState: {
          sourceId,
          objectId,
          contentType: validated.mimeType,
          byteSize: stored.byteSize,
          sha256,
          idempotencyKey: input.idempotencyKey ?? null
        }
      });
    });
  } catch (error) {
    let cataloged;
    try {
      cataloged = await query(
        "SELECT id FROM storage_objects WHERE provider = $1 AND bucket = $2 AND object_key = $3",
        [storage.provider, stored.location.bucket, stored.location.key]
      );
    } catch (reconciliationError) {
      throw new AppError(
        503,
        "QUARANTINE_RECONCILIATION_REQUIRED",
        "Upload metadata outcome could not be reconciled; stored bytes were preserved.",
        {
          failure: safeInternalError(error),
          reconciliation: safeInternalError(reconciliationError),
          objectKey: stored.location.key
        }
      );
    }
    try {
      if (createdObject && !cataloged.rowCount) await storage.delete(stored.location);
    } catch (compensationError) {
      throw new AppError(
        500,
        "QUARANTINE_COMPENSATION_FAILED",
        "Upload metadata failed and its untracked object could not be removed.",
        {
          failure: safeInternalError(error),
          compensation: safeInternalError(compensationError),
          objectKey: stored.location.key
        }
      );
    }
    throw error;
  }
  if (transactionReplay) return transactionReplay;
  return {
    id: documentId,
    projectId: input.projectId,
    sourceId,
    objectId,
    status: "QUARANTINED",
    location: stored.location,
    sha256,
    byteSize: stored.byteSize
  };
}

export interface ScanDocumentOptions {
  maxBytes: number;
  production: boolean;
  allowExplicitDemoBypass?: boolean;
  resumeInProgress?: boolean;
  signal?: AbortSignal;
  actor: DocumentActor;
  jobFence?: DocumentJobFence;
}

export async function scanDocument(
  projectId: string,
  documentId: string,
  storage: ObjectStorage,
  scanner: MalwareScanner,
  options: ScanDocumentOptions
): Promise<{
  status: DocumentStatus;
  scan: MalwareScanResult;
  bypassed: boolean;
  cleanObjectId?: string;
}> {
  assertActor(options.actor);
  const snapshot = await withTransaction(async (client) => {
    const document = await lockDocument(client, projectId, documentId);
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_SCAN",
      options.jobFence
    );
    const resume = document.status === "SCANNING" && options.resumeInProgress === true;
    if (
      !resume &&
      !(["QUARANTINED", "BLOCKED_SCANNER_UNAVAILABLE"] as DocumentStatus[]).includes(
        document.status
      )
    ) {
      throw conflict("DOCUMENT_NOT_SCANNABLE", "Document is not waiting for a malware scan.");
    }
    if (!resume) {
      assertDocumentTransition(document.status, "SCANNING");
      await client.query(
        "UPDATE documents SET status = 'SCANNING', state_reason = NULL, updated_at = NOW() WHERE id = $1",
        [documentId]
      );
    }
    options.signal?.throwIfAborted();
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_SCAN",
      options.jobFence
    );
    return document;
  });
  ensureStorageProvider(storage, snapshot.provider);

  let scan: MalwareScanResult;
  let scannedBytes: Uint8Array | undefined;
  try {
    const bytes = await storage.read(objectLocation(snapshot), {
      maxBytes: options.maxBytes,
      expectedSha256: snapshot.sha256 ?? undefined
    });
    scannedBytes = bytes;
    scan = await scanner.scan({ bytes, signal: options.signal });
    options.signal?.throwIfAborted();
    if (
      scan.objectSha256 !== snapshot.sha256 ||
      scan.byteSize !== Number(snapshot.byte_size)
    ) {
      scan = {
        ...scan,
        status: "ERROR",
        sanitizedError: "Scanner result did not match the stored object metadata."
      };
    }
  } catch {
    options.signal?.throwIfAborted();
    scan = {
      status: "ERROR",
      scanner: scanner.name,
      durationMs: 0,
      byteSize: Number(snapshot.byte_size ?? 0),
      objectSha256: snapshot.sha256 ?? "0".repeat(64),
      sanitizedError: "Stored object could not be read for malware scanning."
    };
  }
  const disposition = resolveScanDisposition(scan, options);
  const cleanObject =
    disposition.documentStatus === "CLEAN" &&
    scan.status === "CLEAN" &&
    !disposition.bypassed &&
    scannedBytes
      ? await prepareCleanSourceObject({
          projectId,
          document: snapshot,
          storage,
          bytes: scannedBytes,
          maxBytes: options.maxBytes
        })
      : undefined;
  options.signal?.throwIfAborted();
  await withTransaction(async (client) => {
    const current = await lockDocument(client, projectId, documentId);
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_SCAN",
      options.jobFence
    );
    if (current.status !== "SCANNING" || current.raw_object_id !== snapshot.raw_object_id) {
      throw conflict("DOCUMENT_SCAN_STALE", "Document changed while malware scanning was running.");
    }
    if (cleanObject) {
      await catalogCleanSourceObject(client, cleanObject, current, options.actor);
    }
    await client.query(
      "INSERT INTO document_scan_results (id, document_id, object_id, object_sha256, scanner," +
        " scanner_version, signature_database_version, result, detected_name, sanitized_error," +
        " duration_ms, byte_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [
        randomUUID(),
        documentId,
        current.raw_object_id,
        scan.objectSha256,
        scan.scanner,
        scan.scannerVersion ?? null,
        scan.signatureDatabaseVersion ?? null,
        scan.status,
        scan.detectedName ?? null,
        scan.sanitizedError ?? null,
        scan.durationMs,
        scan.byteSize
      ]
    );
    assertDocumentTransition("SCANNING", disposition.documentStatus);
    await client.query(
      "UPDATE documents SET status = $2, scan_bypassed = $3, state_reason = $4, updated_at = NOW()" +
        " WHERE id = $1",
      [documentId, disposition.documentStatus, disposition.bypassed, disposition.warning ?? null]
    );
    await client.query(
      "UPDATE storage_objects SET scan_status = $2, updated_at = NOW() WHERE id = $1",
      [current.raw_object_id, scan.status]
    );
    if (cleanObject && current.source_id) {
      await client.query(
        `UPDATE sources
           SET storage_object_id = $2,
               fetch_metadata = fetch_metadata || $3::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
        [
          current.source_id,
          cleanObject.id,
          JSON.stringify({
            cleanStorageObjectId: cleanObject.id,
            cleanObjectKey: cleanObject.location.key
          })
        ]
      );
    }
    await writeAuditEvent(client, {
      projectId,
      actorType: options.actor.actorType,
      actorLabel: options.actor.label,
      action: disposition.documentStatus === "CLEAN" ? "DOCUMENT_SCAN_CLEAN" : "DOCUMENT_SCAN_BLOCKED",
      resourceType: "document",
      resourceId: documentId,
      afterState: {
        result: scan.status,
        scanner: scan.scanner,
        scannerVersion: scan.scannerVersion,
        signatureDatabaseVersion: scan.signatureDatabaseVersion,
        detectedName: scan.detectedName,
        bypassed: disposition.bypassed,
        cleanObjectId: cleanObject?.id ?? null
      }
    });
    options.signal?.throwIfAborted();
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_SCAN",
      options.jobFence
    );
  });
  return {
    status: disposition.documentStatus,
    scan,
    bypassed: disposition.bypassed,
    ...(cleanObject ? { cleanObjectId: cleanObject.id } : {})
  };
}

export type InjectedDocumentExtractor = (input: {
  format: ExtractableDocumentFormat;
  bytes: Uint8Array;
  limits: Partial<ExtractionLimits>;
}) => Promise<DocumentExtractionResult>;

export interface ExtractDocumentOptions {
  maxBytes: number;
  production?: boolean;
  limits?: Partial<ExtractionLimits>;
  chunking?: { maxChars?: number; overlapChars?: number; maxChunks?: number };
  allowExplicitDemoBypass?: boolean;
  resumeInProgress?: boolean;
  signal?: AbortSignal;
  actor: DocumentActor;
  extractor?: InjectedDocumentExtractor;
  jobFence?: DocumentJobFence;
}

async function recordExtractionFailure(input: {
  projectId: string;
  documentId: string;
  version: number;
  extractorName: string;
  extractorVersion: string;
  error: unknown;
  actor: DocumentActor;
  jobFence?: DocumentJobFence;
}): Promise<void> {
  await withTransaction(async (client) => {
    const current = await lockDocument(client, input.projectId, input.documentId);
    await assertDocumentJobFence(
      client,
      input.projectId,
      input.documentId,
      "DOCUMENT_EXTRACT",
      input.jobFence
    );
    if (current.status !== "EXTRACTING") return;
    await client.query(
      "INSERT INTO document_extractions (id, document_id, object_id, version, extractor_name," +
        " extractor_version, status, extraction_confidence, sanitized_error, completed_at)" +
        " VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', 'UNKNOWN', $7, NOW())" +
        " ON CONFLICT (document_id, version) DO NOTHING",
      [
        randomUUID(),
        input.documentId,
        current.raw_object_id,
        input.version,
        input.extractorName,
        input.extractorVersion,
        safeInternalError(input.error)
      ]
    );
    assertDocumentTransition("EXTRACTING", "EXTRACTION_FAILED");
    await client.query(
      "UPDATE documents SET status = 'EXTRACTION_FAILED', state_reason = $2, updated_at = NOW()" +
        " WHERE id = $1",
      [input.documentId, safeInternalError(input.error)]
    );
    await client.query(
      "UPDATE storage_objects SET extraction_status = 'FAILED', last_error = $2, updated_at = NOW()" +
        " WHERE id = $1",
      [current.raw_object_id, safeInternalError(input.error)]
    );
    await writeAuditEvent(client, {
      projectId: input.projectId,
      actorType: input.actor.actorType,
      actorLabel: input.actor.label,
      action: "DOCUMENT_EXTRACTION_FAILED",
      resourceType: "document",
      resourceId: input.documentId,
      afterState: { version: input.version, error: safeInternalError(input.error) }
    });
    await assertDocumentJobFence(
      client,
      input.projectId,
      input.documentId,
      "DOCUMENT_EXTRACT",
      input.jobFence
    );
  });
}

export async function extractDocument(
  projectId: string,
  documentId: string,
  storage: ObjectStorage,
  options: ExtractDocumentOptions
): Promise<{ status: DocumentStatus; extractionId: string; version: number }> {
  assertActor(options.actor);
  options.signal?.throwIfAborted();
  const started = await withTransaction(async (client) => {
    const document = await lockDocument(client, projectId, documentId);
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_EXTRACT",
      options.jobFence
    );
    const clean = document.scan_status === "CLEAN";
    const explicitBypass =
      options.production === false &&
      document.scan_bypassed &&
      options.allowExplicitDemoBypass === true;
    if (!clean && !explicitBypass) {
      throw conflict(
        "DOCUMENT_SCAN_REQUIRED",
        "Only a document with a clean malware scan can be extracted."
      );
    }
    const resume = document.status === "EXTRACTING" && options.resumeInProgress === true;
    if (
      !resume &&
      !(["CLEAN", "READY", "EXTRACTION_FAILED", "OCR_REQUIRED_UNSUPPORTED"] as DocumentStatus[]).includes(
        document.status
      )
    ) {
      throw conflict("DOCUMENT_NOT_EXTRACTABLE", "Document is not ready for extraction.");
    }
    if (!resume) assertDocumentTransition(document.status, "EXTRACTING");
    const versionResult = await client.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0)::integer + 1 AS version" +
        " FROM document_extractions WHERE document_id = $1",
      [documentId]
    );
    const version = versionResult.rows[0].version;
    await client.query(
      "UPDATE documents SET status = 'EXTRACTING', state_reason = NULL, updated_at = NOW() WHERE id = $1",
      [documentId]
    );
    await client.query(
      "UPDATE storage_objects SET extraction_status = 'PENDING', last_error = NULL, updated_at = NOW()" +
        " WHERE id = $1",
      [document.raw_object_id]
    );
    options.signal?.throwIfAborted();
    await assertDocumentJobFence(
      client,
      projectId,
      documentId,
      "DOCUMENT_EXTRACT",
      options.jobFence
    );
    return { document, version, format: formatFor(document) };
  });
  const extractionId = deterministicUploadUuid(
    projectId,
    `${documentId}:${started.version}`,
    "extraction"
  );
  ensureStorageProvider(storage, started.document.provider);
  const limits = { ...options.limits, maxBytes: options.maxBytes };
  let result: DocumentExtractionResult;
  try {
    const bytes = await storage.read(objectLocation(started.document), {
      maxBytes: options.maxBytes,
      expectedSha256: started.document.sha256 ?? undefined
    });
    options.signal?.throwIfAborted();
    result = options.extractor
      ? await options.extractor({ format: started.format, bytes, limits })
      : await builtinExtract(started.format, bytes, limits);
    options.signal?.throwIfAborted();
    validateExtractionResult(
      result,
      started.format,
      started.document.sha256 ?? "",
      options.limits?.maxTextChars ?? 2_000_000
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    await recordExtractionFailure({
      projectId,
      documentId,
      version: started.version,
      extractorName: "document-extractor",
      extractorVersion: "unknown",
      error,
      actor: options.actor,
      jobFence: options.jobFence
    });
    throw new AppError(422, "DOCUMENT_EXTRACTION_FAILED", "Document extraction failed.", {
      reason: safeInternalError(error)
    });
  }

  if (result.status === "OCR_REQUIRED_UNSUPPORTED") {
    const artifact = await prepareExtractionArtifact({
      projectId,
      extractionId,
      document: started.document,
      storage,
      payload: {
        schemaVersion: "document-extraction-artifact.v1",
        projectId,
        documentId,
        extractionId,
        version: started.version,
        result
      },
      maxBytes: options.maxBytes
    });
    options.signal?.throwIfAborted();
    try {
      await withTransaction(async (client) => {
        const current = await lockDocument(client, projectId, documentId);
        await assertDocumentJobFence(
          client,
          projectId,
          documentId,
          "DOCUMENT_EXTRACT",
          options.jobFence
        );
        if (
          current.status !== "EXTRACTING" ||
          current.raw_object_id !== started.document.raw_object_id
        ) {
          throw conflict("DOCUMENT_EXTRACTION_STALE", "Document changed during extraction.");
        }
        await catalogExtractionArtifact(client, artifact, current, options.actor);
        await client.query(
          "INSERT INTO document_extractions (id, document_id, object_id, version, extractor_name," +
            " extractor_version, status, page_count, warnings, extraction_confidence, metadata," +
            " artifact_object_id, completed_at)" +
            " VALUES ($1, $2, $3, $4, $5, $6, 'OCR_REQUIRED_UNSUPPORTED', $7, $8::jsonb," +
            " $9, $10::jsonb, $11, NOW())",
          [
            extractionId,
            documentId,
            current.raw_object_id,
            started.version,
            result.extractorName,
            result.extractorVersion,
            result.pageCount ?? null,
            JSON.stringify(result.warnings),
            result.confidence,
            JSON.stringify(result.metadata),
            artifact.id
          ]
        );
        assertDocumentTransition("EXTRACTING", "OCR_REQUIRED_UNSUPPORTED");
        await client.query(
          "UPDATE documents SET status = 'OCR_REQUIRED_UNSUPPORTED', current_extraction_id = $2," +
            " state_reason = 'OCR_REQUIRED_UNSUPPORTED', updated_at = NOW() WHERE id = $1",
          [documentId, extractionId]
        );
        await client.query(
          "UPDATE storage_objects SET extraction_status = 'OCR_REQUIRED_UNSUPPORTED', updated_at = NOW()" +
            " WHERE id = $1",
          [current.raw_object_id]
        );
        await writeAuditEvent(client, {
          projectId,
          actorType: options.actor.actorType,
          actorLabel: options.actor.label,
          action: "DOCUMENT_OCR_REQUIRED",
          resourceType: "document",
          resourceId: documentId,
          afterState: { extractionId, version: started.version, pageCount: result.pageCount }
        });
        options.signal?.throwIfAborted();
        await assertDocumentJobFence(
          client,
          projectId,
          documentId,
          "DOCUMENT_EXTRACT",
          options.jobFence
        );
      });
    } catch (error) {
      if (isJobLeaseLost(error)) throw error;
      await recordExtractionFailure({
        projectId,
        documentId,
        version: started.version,
        extractorName: result.extractorName,
        extractorVersion: result.extractorVersion,
        error,
        actor: options.actor,
        jobFence: options.jobFence
      });
      throw error;
    }
    return { status: "OCR_REQUIRED_UNSUPPORTED", extractionId, version: started.version };
  }

  let mappedResult: DocumentExtractionResult;
  let chunked: ReturnType<typeof chunkExtraction>;
  let persistedChunkIds: Map<string, string>;
  try {
    mappedResult = {
      ...result,
      securitySignals: assessPromptInjection(result.text),
      blocks: result.blocks.map((block) => ({
        ...block,
        id: scopedBlockId(extractionId, block.stableAnchor)
      }))
    };
    chunked = chunkExtraction({
      sourceId: started.document.source_id ?? "",
      documentId,
      extractionId,
      extraction: mappedResult,
      options: options.chunking
    });
    persistedChunkIds = new Map(
      chunked.chunks.map((chunk) => [chunk.id, scopedChunkId(extractionId, chunk.id)])
    );
  } catch (error) {
    await recordExtractionFailure({
      projectId,
      documentId,
      version: started.version,
      extractorName: result.extractorName,
      extractorVersion: result.extractorVersion,
      error,
      actor: options.actor,
      jobFence: options.jobFence
    });
    throw new AppError(422, "DOCUMENT_CHUNKING_FAILED", "Document chunking failed.", {
      reason: safeInternalError(error)
    });
  }
  const artifact = await prepareExtractionArtifact({
    projectId,
    extractionId,
    document: started.document,
    storage,
    payload: {
      schemaVersion: "document-extraction-artifact.v1",
      projectId,
      documentId,
      extractionId,
      version: started.version,
      result: mappedResult,
      chunks: chunked.chunks.map((chunk) => ({
        ...chunk,
        id: persistedChunkIds.get(chunk.id)
      })),
      anchors: chunked.anchors
    },
    maxBytes: options.maxBytes
  });
  options.signal?.throwIfAborted();
  try {
    await withTransaction(async (client) => {
      const current = await lockDocument(client, projectId, documentId);
      await assertDocumentJobFence(
        client,
        projectId,
        documentId,
        "DOCUMENT_EXTRACT",
        options.jobFence
      );
      if (
        current.status !== "EXTRACTING" ||
        current.raw_object_id !== started.document.raw_object_id ||
        current.sha256 !== started.document.sha256 ||
        (!current.scan_bypassed && current.scan_status !== "CLEAN")
      ) {
        throw conflict("DOCUMENT_EXTRACTION_STALE", "Document changed during extraction.");
      }
      if (!current.source_id) {
        throw conflict("DOCUMENT_SOURCE_MISSING", "Document source no longer exists.");
      }
      await catalogExtractionArtifact(client, artifact, current, options.actor);
      await client.query(
        "INSERT INTO document_extractions (id, document_id, object_id, version, extractor_name," +
          " extractor_version, status, content_hash, language, page_count, warnings," +
          " extraction_confidence, metadata, artifact_object_id, completed_at)" +
          " VALUES ($1, $2, $3, $4, $5, $6, 'SUCCEEDED', $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, NOW())",
        [
          extractionId,
          documentId,
          current.raw_object_id,
          started.version,
          result.extractorName,
          result.extractorVersion,
          result.contentHash,
          result.language ?? null,
          result.pageCount ?? null,
          JSON.stringify(result.warnings),
          result.confidence,
          JSON.stringify(result.metadata),
          artifact.id
        ]
      );
      for (const block of mappedResult.blocks) {
        await client.query(
          "INSERT INTO document_blocks (id, extraction_id, ordinal, block_kind, page_number," +
            " section_path, paragraph_index, text, start_offset, end_offset, stable_anchor," +
            " language, content_hash, extraction_confidence, metadata)" +
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)",
          [
            block.id,
            extractionId,
            block.ordinal,
            block.kind,
            block.pageNumber ?? null,
            block.sectionPath ?? null,
            block.paragraphIndex ?? null,
            block.text,
            block.startOffset,
            block.endOffset,
            block.stableAnchor,
            block.language ?? null,
            block.contentHash,
            block.confidence,
            JSON.stringify(block.metadata)
          ]
        );
      }
      for (const chunk of chunked.chunks) {
        const persistedChunkId = persistedChunkIds.get(chunk.id);
        if (!persistedChunkId) throw new Error("Chunk persistence mapping is missing.");
        await client.query(
          "INSERT INTO document_chunks (id, extraction_id, stable_chunk_id, ordinal, text, start_offset, end_offset," +
            " start_block_id, end_block_id, page_number, section_path, char_count, content_hash," +
            " chunker_version, prompt_injection_flag, security_signals)" +
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)",
          [
            persistedChunkId,
            extractionId,
            chunk.id,
            chunk.ordinal,
            chunk.text,
            chunk.startOffset,
            chunk.endOffset,
            chunk.startBlockId,
            chunk.endBlockId,
            chunk.pageNumber ?? null,
            chunk.sectionPath ?? null,
            chunk.charCount,
            chunk.contentHash,
            chunk.chunkerVersion,
            chunk.securitySignals.flagged,
            JSON.stringify(chunk.securitySignals.indicators)
          ]
        );
      }
      for (const anchor of chunked.anchors) {
        const persistedChunkId = persistedChunkIds.get(anchor.chunkId);
        if (!persistedChunkId) throw new Error("Anchor chunk persistence mapping is missing.");
        await client.query(
          "INSERT INTO citation_anchors (id, source_id, document_id, extraction_id, chunk_id," +
            " page_number, section_path, start_offset, end_offset, content_hash, status)" +
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CURRENT')",
          [
            anchor.id,
            current.source_id,
            documentId,
            extractionId,
            persistedChunkId,
            anchor.pageNumber ?? null,
            anchor.sectionPath ?? null,
            anchor.startOffset,
            anchor.endOffset,
            anchor.contentHash
          ]
        );
      }
      await client.query(
        "UPDATE citation_anchors SET status = 'NEEDS_REVIEW', updated_at = NOW()" +
          " WHERE document_id = $1 AND extraction_id <> $2 AND status = 'CURRENT'",
        [documentId, extractionId]
      );
      await client.query(
        "UPDATE evidence e SET citation_status = 'NEEDS_REVIEW', updated_at = NOW()" +
          " FROM citation_anchors a WHERE e.citation_anchor_id = a.id" +
          " AND a.document_id = $1 AND a.extraction_id <> $2",
        [documentId, extractionId]
      );
      const duplicate = await client.query<{ id: string }>(
        "SELECT id FROM sources WHERE project_id = $1 AND content_hash = $2 AND id <> $3 LIMIT 1",
        [projectId, result.contentHash, current.source_id]
      );
      await client.query(
        "UPDATE sources SET sanitized_content = $2, content_summary = $3, content_hash = $4," +
          " duplicate_of_source_id = $5, prompt_injection_flag = $6," +
          " fetch_metadata = fetch_metadata || $7::jsonb, updated_at = NOW() WHERE id = $1",
        [
          current.source_id,
          result.text,
          result.text.replace(/\s+/g, " ").slice(0, 1_500),
          result.contentHash,
          duplicate.rows[0]?.id ?? null,
          mappedResult.securitySignals.flagged,
          JSON.stringify({
            documentStatus: "READY",
            currentExtractionId: extractionId,
            extractionVersion: started.version,
            chunkCount: chunked.chunks.length,
            promptInjection: mappedResult.securitySignals
          })
        ]
      );
      assertDocumentTransition("EXTRACTING", "READY");
      await client.query(
        "UPDATE documents SET status = 'READY', current_extraction_id = $2, state_reason = NULL," +
          " updated_at = NOW() WHERE id = $1",
        [documentId, extractionId]
      );
      await client.query(
        "UPDATE storage_objects SET extraction_status = 'READY', last_error = NULL, updated_at = NOW()" +
          " WHERE id = $1",
        [current.raw_object_id]
      );
      await invalidateDownstreamReview(client, projectId, "RESEARCHING");
      await writeAuditEvent(client, {
        projectId,
        actorType: options.actor.actorType,
        actorLabel: options.actor.label,
        action: "DOCUMENT_EXTRACTION_READY",
        resourceType: "document",
        resourceId: documentId,
        afterState: {
          extractionId,
          version: started.version,
          blockCount: mappedResult.blocks.length,
          chunkCount: chunked.chunks.length,
          contentHash: result.contentHash,
          promptInjectionFlag: mappedResult.securitySignals.flagged
        }
      });
      options.signal?.throwIfAborted();
      await assertDocumentJobFence(
        client,
        projectId,
        documentId,
        "DOCUMENT_EXTRACT",
        options.jobFence
      );
    });
  } catch (error) {
    if (isJobLeaseLost(error)) throw error;
    await recordExtractionFailure({
      projectId,
      documentId,
      version: started.version,
      extractorName: result.extractorName,
      extractorVersion: result.extractorVersion,
      error,
      actor: options.actor,
      jobFence: options.jobFence
    });
    throw error;
  }
  return { status: "READY", extractionId, version: started.version };
}

export interface ReadDocumentObjectResult {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  sha256: string;
}

export async function readDocumentObject(
  projectId: string,
  documentId: string,
  storage: ObjectStorage,
  actor: DocumentActor | null,
  maxBytes: number
): Promise<ReadDocumentObjectResult> {
  assertAuthenticatedOperator(actor);
  const result = await query<LockedDocument>(
    "SELECT d.id, d.project_id, d.source_id, d.raw_object_id, d.status, d.scan_bypassed," +
      " d.current_extraction_id, o.provider, o.bucket, o.object_key, o.content_type," +
      " o.original_filename, o.sanitized_filename, o.byte_size::text, o.sha256," +
      " o.integrity_status, o.upload_status, o.scan_status, o.retention_status" +
      " FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id" +
      " WHERE d.id = $1 AND d.project_id = $2",
    [documentId, projectId]
  );
  const document = result.rows[0];
  if (!document) throw notFound("Document");
  if (
    document.scan_status !== "CLEAN" ||
    document.integrity_status !== "VERIFIED" ||
    document.upload_status !== "AVAILABLE" ||
    document.retention_status !== "ACTIVE" ||
    document.status === "DELETED" ||
    !document.sha256
  ) {
    throw conflict("DOCUMENT_NOT_DOWNLOADABLE", "Document is not a clean downloadable object.");
  }
  ensureStorageProvider(storage, document.provider);
  const bytes = await storage.read(objectLocation(document), {
    maxBytes,
    expectedSha256: document.sha256
  });
  await withTransaction(async (client) => {
    await lockProject(client, projectId);
    await writeAuditEvent(client, {
      projectId,
      actorType: actor.actorType,
      actorLabel: actor.label,
      action: "DOCUMENT_DOWNLOADED",
      resourceType: "document",
      resourceId: documentId,
      afterState: { byteSize: bytes.byteLength, sha256: document.sha256 }
    });
  });
  return {
    bytes,
    contentType: document.content_type,
    filename: document.sanitized_filename ?? "document",
    sha256: document.sha256
  };
}

export async function deleteDocument(
  projectId: string,
  documentId: string,
  actor: DocumentActor | null
): Promise<{
  objectId: string;
  objectIds: string[];
  cleanupJobId: string;
  cleanupStatus: "PENDING_DELETE";
}> {
  assertAuthenticatedOperator(actor);
  return withTransaction(async (client) => {
    const document = await lockDocument(client, projectId, documentId);
    const activeJobs = await client.query<{
      id: string;
      job_type: string;
      status: string;
      document_id: string | null;
    }>(
      `SELECT id, job_type, status, input_reference ->> 'documentId' AS document_id
       FROM jobs
       WHERE project_id = $1
         AND status IN (
           'QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAIT', 'CANCELLATION_REQUESTED'
         )
       ORDER BY id FOR UPDATE`,
      [projectId]
    );
    const isCancellableDocumentJob = (job: (typeof activeJobs.rows)[number]) =>
      ["QUEUED", "RETRY_WAIT"].includes(job.status) &&
      ["DOCUMENT_SCAN", "DOCUMENT_EXTRACT"].includes(job.job_type) &&
      job.document_id === documentId;
    if (
      document.status !== "DELETED" &&
      activeJobs.rows.some((job) => !isCancellableDocumentJob(job))
    ) {
      throw conflict(
        "DOCUMENT_JOBS_ACTIVE",
        "Cancel active project jobs, wait for their workers to drain, and retry document deletion."
      );
    }
    for (const job of activeJobs.rows.filter(isCancellableDocumentJob)) {
      await requestJobCancellationInTransaction(
        client,
        job.id,
        `${actor.label} (document deletion)`
      );
    }
    const associatedObjects = await client.query<{
      id: string;
      retention_status: string;
    }>(
      `SELECT id, retention_status
       FROM storage_objects
       WHERE project_id = $1
         AND (id = $2 OR ($3::text IS NOT NULL AND source_id = $3))
       ORDER BY id
       FOR UPDATE`,
      [projectId, document.raw_object_id, document.source_id]
    );
    if (associatedObjects.rows.some((object) => object.retention_status === "LEGAL_HOLD")) {
      throw conflict("DOCUMENT_LEGAL_HOLD", "Document is under legal hold and cannot be deleted.");
    }
    const objectIds = [
      ...new Set([
        document.raw_object_id,
        ...associatedObjects.rows.map((object) => object.id)
      ])
    ].sort();
    const cleanup = await submitJobInTransaction(client, {
      projectId,
      jobType: "STORAGE_CLEANUP",
      inputReference: { deleteUntracked: false, limit: 1_000, objectIds },
      idempotencyKey: `document-delete:${documentId}:storage-cleanup`,
      correlationId: `document-delete:${documentId}`,
      priority: 50,
      maxAttempts: 10
    });
    await client.query(
      "UPDATE storage_objects SET retention_status = 'PENDING_DELETE', cleanup_lease_owner = NULL," +
        " cleanup_lease_expires_at = NULL, updated_at = NOW()" +
        " WHERE id = ANY($1::text[]) AND retention_status IN ('ACTIVE', 'PENDING_DELETE')",
      [objectIds]
    );
    if (document.status === "DELETED") {
      return {
        objectId: document.raw_object_id,
        objectIds,
        cleanupJobId: cleanup.job.id,
        cleanupStatus: "PENDING_DELETE" as const
      };
    }
    assertDocumentTransition(document.status, "DELETED");
    await client.query(
      "UPDATE documents SET status = 'DELETED', state_reason = 'Operator deletion', deleted_at = NOW()," +
        " updated_at = NOW() WHERE id = $1",
      [documentId]
    );
    await client.query(
      "UPDATE citation_anchors SET status = 'NEEDS_REVIEW', updated_at = NOW()" +
        " WHERE document_id = $1 AND status = 'CURRENT'",
      [documentId]
    );
    await client.query(
      "UPDATE evidence SET citation_status = 'NEEDS_REVIEW', updated_at = NOW() WHERE document_id = $1",
      [documentId]
    );
    if (document.source_id) {
      await client.query(
        "UPDATE sources SET original_status = 'REMOVED', sanitized_content = NULL, content_hash = NULL," +
          " content_summary = 'Uploaded document deleted; source content is unavailable.'," +
          " prompt_injection_flag = FALSE, storage_object_id = NULL, updated_at = NOW() WHERE id = $1",
        [document.source_id]
      );
    }
    await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    await writeAuditEvent(client, {
      projectId,
      actorType: actor.actorType,
      actorLabel: actor.label,
      action: "DOCUMENT_DELETE_REQUESTED",
      resourceType: "document",
      resourceId: documentId,
      afterState: {
        objectId: document.raw_object_id,
        objectIds,
        cleanupJobId: cleanup.job.id,
        cleanupStatus: "PENDING_DELETE"
      }
    });
    return {
      objectId: document.raw_object_id,
      objectIds,
      cleanupJobId: cleanup.job.id,
      cleanupStatus: "PENDING_DELETE" as const
    };
  });
}

type DocumentSummaryRow = {
  id: string;
  project_id: string;
  source_id: string | null;
  raw_object_id: string;
  status: DocumentStatus;
  state_reason: string | null;
  scan_bypassed: boolean;
  current_extraction_id: string | null;
  title: string | null;
  provider: StorageProviderKind;
  content_type: string;
  original_filename: string | null;
  sanitized_filename: string | null;
  byte_size: string | null;
  sha256: string | null;
  integrity_status: string;
  upload_status: string;
  scan_status: MalwareScanResult["status"];
  extraction_status: string;
  retention_status: string;
  created_at: Date;
  updated_at: Date;
};

export type DocumentSummary = {
  id: string;
  projectId: string;
  sourceId: string | null;
  objectId: string;
  title: string;
  status: DocumentStatus;
  stateReason: string | null;
  scanBypassed: boolean;
  currentExtractionId: string | null;
  provider: StorageProviderKind;
  contentType: string;
  originalFilename: string | null;
  filename: string;
  byteSize: number | null;
  sha256: string | null;
  integrityStatus: string;
  uploadStatus: string;
  scanStatus: MalwareScanResult["status"];
  extractionStatus: string;
  retentionStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

function documentSummary(row: DocumentSummaryRow): DocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    objectId: row.raw_object_id,
    title: row.title ?? row.sanitized_filename ?? "Document",
    status: row.status,
    stateReason: row.state_reason,
    scanBypassed: row.scan_bypassed,
    currentExtractionId: row.current_extraction_id,
    provider: row.provider,
    contentType: row.content_type,
    originalFilename: row.original_filename,
    filename: row.sanitized_filename ?? "document",
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    sha256: row.sha256,
    integrityStatus: row.integrity_status,
    uploadStatus: row.upload_status,
    scanStatus: row.scan_status,
    extractionStatus: row.extraction_status,
    retentionStatus: row.retention_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const documentSummarySelect =
  "SELECT d.id, d.project_id, d.source_id, d.raw_object_id, d.status, d.state_reason," +
  " d.scan_bypassed, d.current_extraction_id, d.created_at, d.updated_at, s.title," +
  " o.provider, o.content_type, o.original_filename, o.sanitized_filename," +
  " o.byte_size::text, o.sha256, o.integrity_status, o.upload_status, o.scan_status," +
  " o.extraction_status, o.retention_status FROM documents d" +
  " JOIN storage_objects o ON o.id = d.raw_object_id" +
  " LEFT JOIN sources s ON s.id = d.source_id";

async function assertProjectExists(projectId: string): Promise<void> {
  const project = await query("SELECT id FROM research_projects WHERE id = $1", [projectId]);
  if (!project.rowCount) throw notFound("Project");
}

export async function listDocuments(
  projectId: string,
  options: { status?: DocumentStatus; includeDeleted?: boolean } = {}
): Promise<DocumentSummary[]> {
  await assertProjectExists(projectId);
  const values: unknown[] = [projectId];
  const clauses = ["d.project_id = $1"];
  if (options.status) {
    values.push(options.status);
    clauses.push(`d.status = $${values.length}`);
  } else if (!options.includeDeleted) {
    clauses.push("d.status <> 'DELETED'");
  }
  const result = await query<DocumentSummaryRow>(
    documentSummarySelect +
      " WHERE " +
      clauses.join(" AND ") +
      " ORDER BY d.created_at DESC, d.id",
    values
  );
  return result.rows.map(documentSummary);
}

export async function getDocumentDetail(
  projectId: string,
  documentId: string
): Promise<{
  document: DocumentSummary;
  scans: readonly Record<string, unknown>[];
  extractions: readonly Record<string, unknown>[];
}> {
  const document = await query<DocumentSummaryRow>(
    documentSummarySelect + " WHERE d.project_id = $1 AND d.id = $2",
    [projectId, documentId]
  );
  if (!document.rows[0]) throw notFound("Document");
  const [scans, extractions] = await Promise.all([
    query(
      "SELECT id, scanner, scanner_version, signature_database_version, result," +
        " detected_name, sanitized_error, duration_ms, byte_size, created_at" +
        " FROM document_scan_results WHERE document_id = $1 ORDER BY created_at DESC, id LIMIT 100",
      [documentId]
    ),
    query(
      "SELECT x.id, x.version, x.extractor_name, x.extractor_version, x.status," +
        " x.content_hash, x.language, x.page_count, x.warnings, x.extraction_confidence," +
        " x.metadata, x.sanitized_error, x.started_at, x.completed_at," +
        " (SELECT COUNT(*)::integer FROM document_blocks b WHERE b.extraction_id = x.id) AS block_count," +
        " (SELECT COUNT(*)::integer FROM document_chunks c WHERE c.extraction_id = x.id) AS chunk_count" +
        " FROM document_extractions x WHERE x.document_id = $1 ORDER BY x.version DESC LIMIT 100",
      [documentId]
    )
  ]);
  return {
    document: documentSummary(document.rows[0]),
    scans: scans.rows,
    extractions: extractions.rows
  };
}

export async function getDocumentProcessingState(
  projectId: string,
  documentId: string
): Promise<{
  status: DocumentStatus;
  currentExtractionId: string | null;
  objectSha256: string;
  scanStatus: MalwareScanResult["status"];
}> {
  const result = await query<{
    status: DocumentStatus;
    current_extraction_id: string | null;
    sha256: string | null;
    scan_status: MalwareScanResult["status"];
  }>(
    "SELECT d.status, d.current_extraction_id, o.sha256, o.scan_status" +
      " FROM documents d JOIN storage_objects o ON o.id = d.raw_object_id" +
      " WHERE d.project_id = $1 AND d.id = $2",
    [projectId, documentId]
  );
  const row = result.rows[0];
  if (!row) throw notFound("Document");
  if (!row.sha256) {
    throw conflict("DOCUMENT_INTEGRITY_PENDING", "Document integrity metadata is unavailable.");
  }
  return {
    status: row.status,
    currentExtractionId: row.current_extraction_id,
    objectSha256: row.sha256,
    scanStatus: row.scan_status
  };
}
