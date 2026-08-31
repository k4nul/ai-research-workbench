import path from "node:path";
import { z } from "zod";
import type { RequestPrincipal } from "@/lib/auth/dal";
import { getDocumentRuntime } from "@/lib/documents/runtime";
import { enqueueDocumentScan } from "@/lib/services/document-jobs";
import {
  getDocumentDetail,
  quarantineDocument,
  type DocumentActor
} from "@/lib/services/documents";
import { AppError } from "@/lib/services/errors";

const durableDocumentExtensions = new Set([
  ".csv",
  ".docx",
  ".htm",
  ".html",
  ".json",
  ".md",
  ".pdf",
  ".txt"
]);
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export const documentProjectIdSchema = z.string().trim().min(1).max(500);

const uploadMetadataSchema = z.object({
  title: z.string().trim().min(2).max(500).optional(),
  publisher: z.string().trim().max(500).optional(),
  author: z.string().trim().max(500).optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sourceType: z.string().trim().min(2).max(80).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  reliabilityGrade: z.enum(["A", "B", "C", "D", "UNRATED"]).optional(),
  usageRestrictions: z.string().trim().max(2_000).optional()
});

function optionalFormText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function documentActor(principal: RequestPrincipal): DocumentActor {
  if (principal.kind === "operator") {
    return {
      actorType: "USER",
      actorId: principal.session.operator.id,
      label: principal.session.operator.displayName
    };
  }
  return {
    actorType: "USER",
    actorId: "demo-operator",
    label: "Demo operator"
  };
}

export function isDurableDocumentFile(file: File): boolean {
  return durableDocumentExtensions.has(path.extname(file.name).toLowerCase());
}

export async function parseBoundedUploadForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || mediaType !== "multipart/form-data") {
    throw new AppError(415, "MULTIPART_REQUIRED", "Document uploads require multipart form data.");
  }
  const maximumBodyBytes =
    getDocumentRuntime().maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES;
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength) {
    if (!/^\d+$/u.test(rawContentLength)) {
      throw new AppError(400, "INVALID_CONTENT_LENGTH", "Upload content length is invalid.");
    }
    if (Number(rawContentLength) > maximumBodyBytes) {
      throw new AppError(413, "INVALID_SIZE", "The upload exceeds the configured size limit.");
    }
  }
  if (!request.body) {
    throw new AppError(400, "FILE_REQUIRED", "Choose a document file to upload.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel("Upload body exceeded its configured bound.");
        throw new AppError(413, "INVALID_SIZE", "The upload exceeds the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body
  });
  try {
    return await boundedRequest.formData();
  } catch (error) {
    throw new AppError(400, "INVALID_MULTIPART", "Upload form data is malformed.", {
      cause: error instanceof Error ? error.message : "Unknown multipart parsing error."
    });
  }
}

export async function quarantineDocumentForm(input: {
  projectId: string;
  form: FormData;
  principal: RequestPrincipal;
  idempotencyKey?: string;
}): Promise<{
  document: Awaited<ReturnType<typeof getDocumentDetail>>["document"];
  scanJob: Awaited<ReturnType<typeof enqueueDocumentScan>>;
}> {
  const file = input.form.get("file");
  if (!(file instanceof File)) {
    throw new AppError(400, "FILE_REQUIRED", "Choose a document file to upload.");
  }
  const runtime = getDocumentRuntime();
  if (file.size > runtime.maxUploadBytes) {
    throw new AppError(413, "INVALID_SIZE", "The upload exceeds the configured size limit.");
  }
  const metadata = uploadMetadataSchema.parse({
    title: optionalFormText(input.form, "title"),
    publisher: optionalFormText(input.form, "publisher"),
    author: optionalFormText(input.form, "author"),
    publishedAt: optionalFormText(input.form, "publishedAt"),
    sourceType: optionalFormText(input.form, "sourceType"),
    language: optionalFormText(input.form, "language"),
    reliabilityGrade: optionalFormText(input.form, "reliabilityGrade"),
    usageRestrictions: optionalFormText(input.form, "usageRestrictions")
  });
  const actor = documentActor(input.principal);
  const quarantined = await quarantineDocument(
    {
      projectId: input.projectId,
      file: {
        filename: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer())
      },
      source: metadata,
      actor,
      idempotencyKey: input.idempotencyKey,
      maxBytes: runtime.maxUploadBytes,
      bucket: runtime.storageBucket
    },
    runtime.storage
  );
  const scanJob = await enqueueDocumentScan({
    projectId: input.projectId,
    documentId: quarantined.id,
    idempotencyKey: "initial-scan",
    autoExtract: true,
    actor
  });
  return {
    document: (await getDocumentDetail(input.projectId, quarantined.id)).document,
    scanJob
  };
}
