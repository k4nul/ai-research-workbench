import { z } from "zod";
import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { updateResearchQuestion } from "@/lib/services/workflow";

type Context = {
  params: Promise<{ projectId: string; questionId: string }>;
};

const updateSchema = z.object({
  status: z.enum(["OPEN", "PLANNED", "RESEARCHING", "COMPLETE", "BLOCKED"]).optional(),
  gapStatus: z.enum(["NONE", "OPEN", "ACCEPTED", "RESOLVED"]).optional(),
  researchGap: z.string().trim().max(4_000).optional()
});

export async function PATCH(request: Request, context: Context) {
  const { projectId, questionId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) =>
    updateResearchQuestion(
      projectId,
      questionId,
      updateSchema.parse(await request.json()),
      principalAuditActor(principal)
    )
  );
}
