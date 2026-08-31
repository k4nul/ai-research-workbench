import { z } from "zod";
import { requireAuthenticatedApiRequest } from "@/lib/auth/dal";
import { documentActor, documentProjectIdSchema } from "@/lib/documents/http";
import { getDocumentRuntime } from "@/lib/documents/runtime";
import { noStoreJsonHeaders, routeErrorResponse } from "@/lib/http";
import { readDocumentObject } from "@/lib/services/documents";

type Context = { params: Promise<{ projectId: string; documentId: string }> };

const pathSchema = z.object({
  projectId: documentProjectIdSchema,
  documentId: z.string().uuid()
});

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(request: Request, context: Context) {
  try {
    const principal = await requireAuthenticatedApiRequest(request);
    const { projectId, documentId } = pathSchema.parse(await context.params);
    const runtime = getDocumentRuntime();
    const result = await readDocumentObject(
      projectId,
      documentId,
      runtime.storage,
      documentActor(principal),
      runtime.maxObjectBytes
    );
    const body = new Uint8Array(result.bytes.byteLength);
    body.set(result.bytes);
    return new Response(body, {
      headers: {
        ...noStoreJsonHeaders(),
        "Content-Type": result.contentType,
        "Content-Disposition": contentDisposition(result.filename),
        "Content-Length": String(body.byteLength)
      }
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
