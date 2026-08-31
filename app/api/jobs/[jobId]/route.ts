import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { operationIdSchema } from "@/lib/operations/request";
import { getJobOperationsDetail } from "@/lib/services/operations";

type Context = { params: Promise<{ jobId: string }> };

const querySchema = z.object({ projectId: operationIdSchema.optional() }).strict();

export async function GET(request: Request, context: Context) {
  return handleAuthenticatedRoute(request, async () => {
    const { jobId } = z.object({ jobId: operationIdSchema }).parse(await context.params);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return getJobOperationsDetail(jobId, input.projectId);
  });
}
