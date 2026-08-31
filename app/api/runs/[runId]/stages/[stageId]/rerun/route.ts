import { z } from "zod";

import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  operationIdSchema,
  projectMutationSchema,
  requestIdempotencyKey
} from "@/lib/operations/request";
import {
  getResearchRunOperationsDetail,
  rerunStageForOperator
} from "@/lib/services/operations";

type Context = { params: Promise<{ runId: string; stageId: string }> };

export async function POST(request: Request, context: Context) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const { runId, stageId } = z
        .object({ runId: operationIdSchema, stageId: operationIdSchema })
        .parse(await context.params);
      const { projectId } = projectMutationSchema.parse(await request.json());
      const restarted = await rerunStageForOperator({
        runId,
        runStageId: stageId,
        projectId,
        actor: principalAuditActor(principal),
        idempotencyKey: requestIdempotencyKey(request)
      });
      return {
        ...(await getResearchRunOperationsDetail(runId, projectId)),
        created: restarted.created
      };
    },
    { mutation: true }
  );
}
