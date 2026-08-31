import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { operationIdSchema } from "@/lib/operations/request";
import { getResearchRunOperationsDetail } from "@/lib/services/operations";

type Context = { params: Promise<{ runId: string }> };

const querySchema = z.object({ projectId: operationIdSchema.optional() }).strict();

export async function GET(request: Request, context: Context) {
  return handleAuthenticatedRoute(request, async () => {
    const { runId } = z.object({ runId: operationIdSchema }).parse(await context.params);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const detail = await getResearchRunOperationsDetail(runId, input.projectId);
    return detail.stages;
  });
}
