import { z } from "zod";

import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  jobMutationScopeSchema,
  operationIdSchema,
  requestIdempotencyKey
} from "@/lib/operations/request";
import { retryJobForOperator } from "@/lib/services/operations";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { jobId } = z.object({ jobId: operationIdSchema }).parse(await context.params);
      const { projectId } = jobMutationScopeSchema.parse(await request.json());
      return retryJobForOperator({
        jobId,
        projectId,
        actor: principalAuditActor(principal),
        idempotencyKey: requestIdempotencyKey(request)
      });
    },
    { mutation: true }
  );
}
