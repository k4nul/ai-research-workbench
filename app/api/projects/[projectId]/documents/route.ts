import { z } from "zod";
import { DOCUMENT_STATUSES } from "@/lib/documents";
import {
  documentProjectIdSchema,
  parseBoundedUploadForm,
  quarantineDocumentForm
} from "@/lib/documents/http";
import { enforceRateLimit, handleAuthenticatedRoute } from "@/lib/http";
import { requestIdempotencyKey } from "@/lib/operations/request";
import { listDocuments } from "@/lib/services/documents";

type Context = { params: Promise<{ projectId: string }> };

const pathSchema = z.object({ projectId: documentProjectIdSchema });
const querySchema = z.object({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  includeDeleted: z.enum(["true", "false"]).optional().transform((value) => value === "true")
});

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  return handleAuthenticatedRoute(request, async () => {
    const { projectId } = pathSchema.parse(await context.params);
    const url = new URL(request.url);
    const options = querySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      includeDeleted: url.searchParams.get("includeDeleted") ?? undefined
    });
    return listDocuments(projectId, options);
  });
}

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const idempotencyKey = requestIdempotencyKey(request);
      enforceRateLimit(request, "document-upload", 10);
      const { projectId } = pathSchema.parse(await context.params);
      return quarantineDocumentForm({
        projectId,
        form: await parseBoundedUploadForm(request),
        principal,
        idempotencyKey
      });
    },
    { status: 201, mutation: true, idempotency: "dedicated" }
  );
}
