import { z } from "zod";

import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  operationIdSchema,
  projectMutationSchema,
  requestIdempotencyKey
} from "@/lib/operations/request";
import { cancelRunForOperator } from "@/lib/services/operations";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { runId } = z.object({ runId: operationIdSchema }).parse(await context.params);
      const { projectId } = projectMutationSchema.parse(await request.json());
      return cancelRunForOperator({
        runId,
        projectId,
        actor: principalAuditActor(principal),
        idempotencyKey: requestIdempotencyKey(request)
      });
    },
    { mutation: true }
  );
}
