import { enforceRateLimit, handleAuthenticatedRoute } from "@/lib/http";
import {
  documentProjectIdSchema,
  parseBoundedUploadForm,
  quarantineDocumentForm
} from "@/lib/documents/http";
import { query } from "@/lib/db";
import { requestIdempotencyKey } from "@/lib/operations/request";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(request, async (principal) => {
    const idempotencyKey = requestIdempotencyKey(request);
    enforceRateLimit(request, "source-upload", 10);
    const projectId = documentProjectIdSchema.parse((await context.params).projectId);
    const form = await parseBoundedUploadForm(request);
    const uploaded = await quarantineDocumentForm({
      projectId,
      form,
      principal,
      idempotencyKey
    });
    const source = await query("SELECT * FROM sources WHERE id = $1 AND project_id = $2", [
      uploaded.document.sourceId,
      projectId
    ]);
    return {
      ...source.rows[0],
      document_id: uploaded.document.id,
      document_status: uploaded.document.status,
      scan_job: uploaded.scanJob
    };
  }, { status: 201, mutation: true, idempotency: "dedicated" });
}
