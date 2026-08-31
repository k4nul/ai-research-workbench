import { z } from "zod";
import { documentActor, documentProjectIdSchema } from "@/lib/documents/http";
import { handleAuthenticatedRoute } from "@/lib/http";
import { enqueueDocumentExtraction } from "@/lib/services/document-jobs";
import { AppError } from "@/lib/services/errors";

type Context = { params: Promise<{ projectId: string; documentId: string }> };

const pathSchema = z.object({
  projectId: documentProjectIdSchema,
  documentId: z.string().uuid()
});
const bodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional()
}).strict();
const keySchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { projectId, documentId } = pathSchema.parse(await context.params);
      const text = await request.text();
      const body = bodySchema.parse(text ? JSON.parse(text) : {});
      const headerKey = request.headers.get("idempotency-key")?.trim();
      if (headerKey && body.idempotencyKey && headerKey !== body.idempotencyKey) {
        throw new AppError(400, "IDEMPOTENCY_KEY_MISMATCH", "Body and header idempotency keys differ.");
      }
      return enqueueDocumentExtraction({
        projectId,
        documentId,
        idempotencyKey: keySchema.parse(headerKey ?? body.idempotencyKey),
        actor: documentActor(principal)
      });
    },
    { status: 202, mutation: true }
  );
}
