import { z } from "zod";

import { principalAuditActor } from "@/lib/auth/audit-actor";
import { RESEARCH_RUN_STATUSES } from "@/lib/domain/research-runs";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  operationIdSchema,
  requestIdempotencyKey
} from "@/lib/operations/request";
import {
  getResearchRunOperationsDetail,
  listResearchRuns
} from "@/lib/services/operations";
import { createResearchRun } from "@/lib/services/research-runs";

const querySchema = z
  .object({
    projectId: operationIdSchema.optional(),
    status: z.enum(RESEARCH_RUN_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0)
  })
  .strict();

const createSchema = z
  .object({
    projectId: operationIdSchema,
    mode: z.enum(["ASSISTED", "ORCHESTRATED", "DRAFT_ONLY"])
  })
  .strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return listResearchRuns(input);
  });
}

export async function POST(request: Request) {
  return handleAuthenticatedRoute(
    request,
    async (principal) => {
      const input = createSchema.parse(await request.json());
      const actor = principalAuditActor(principal);
      const created = await createResearchRun({
        ...input,
        idempotencyKey: requestIdempotencyKey(request),
        createdBy: actor.actorLabel
      });
      return {
        ...(await getResearchRunOperationsDetail(created.run.id, input.projectId)),
        created: created.created
      };
    },
    { status: 201, mutation: true }
  );
}
