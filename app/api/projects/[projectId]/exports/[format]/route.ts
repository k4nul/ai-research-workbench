import { z } from "zod";
import { principalAuditActor } from "@/lib/auth/audit-actor";
import { requireAuthenticatedApiRequest } from "@/lib/auth/dal";
import { handleAuthenticatedRoute, routeErrorResponse } from "@/lib/http";
import {
  generateArtifact,
  type ExportFormat
} from "@/lib/export/generate";
import { requestIdempotencyKey } from "@/lib/operations/request";
import {
  exportFormatSchema,
  submitProjectExportJob
} from "@/lib/services/export-jobs";
import { AppError } from "@/lib/services/errors";

type Context = {
  params: Promise<{ projectId: string; format: string }>;
};

const formatSchema = z.enum(["markdown", "html", "pdf", "docx", "csv", "zip"]);

function exportFormat(rawFormat: string): ExportFormat {
  return exportFormatSchema.parse(formatSchema.parse(rawFormat.toLowerCase()).toUpperCase());
}

export async function GET(request: Request, context: Context) {
  try {
    await requireAuthenticatedApiRequest(request);
    if (new URL(request.url).searchParams.has("persist")) {
      throw new AppError(
        405,
        "EXPORT_PERSIST_POST_REQUIRED",
        "Persisted exports must be submitted through the idempotent POST endpoint."
      );
    }
    const { projectId, format: rawFormat } = await context.params;
    const format = exportFormat(rawFormat);
    const artifact = await generateArtifact(projectId, format, { persist: false });
    const body = new Uint8Array(artifact.buffer.byteLength);
    body.set(artifact.buffer);
    return new Response(body, {
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": 'attachment; filename="' + artifact.filename + '"',
        "Content-Length": String(artifact.buffer.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { projectId, format: rawFormat } = await context.params;
      return submitProjectExportJob({
        projectId,
        format: exportFormat(rawFormat),
        idempotencyKey: requestIdempotencyKey(request),
        actor: principalAuditActor(principal)
      });
    },
    { status: 202, mutation: true }
  );
}
