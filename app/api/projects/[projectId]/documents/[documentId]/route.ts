import { z } from "zod";
import { documentActor, documentProjectIdSchema } from "@/lib/documents/http";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  deleteDocument,
  getDocumentDetail
} from "@/lib/services/documents";

type Context = { params: Promise<{ projectId: string; documentId: string }> };

const pathSchema = z.object({
  projectId: documentProjectIdSchema,
  documentId: z.string().uuid()
});

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  return handleAuthenticatedRoute(request, async () => {
    const { projectId, documentId } = pathSchema.parse(await context.params);
    return getDocumentDetail(projectId, documentId);
  });
}

export async function DELETE(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { projectId, documentId } = pathSchema.parse(await context.params);
      const result = await deleteDocument(projectId, documentId, documentActor(principal));
      return { documentId, ...result };
    },
    { mutation: true }
  );
}
