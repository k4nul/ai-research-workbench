import { z } from "zod";
import { handleRoute, enforceRateLimit } from "@/lib/http";
import { approvePlan } from "@/lib/services/projects";
import {
  addResearchPlan,
  generateProviderPlan
} from "@/lib/services/workflow";

type Context = { params: Promise<{ projectId: string }> };

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate") }),
  z.object({ action: z.literal("approve"), planId: z.string().optional() }),
  z.object({ action: z.literal("save"), plan: z.unknown() })
]);

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    enforceRateLimit(request, "research-plan", 10);
    const input = actionSchema.parse(await request.json());
    if (input.action === "generate") {
      return generateProviderPlan(projectId);
    }
    if (input.action === "approve") {
      return approvePlan(projectId, input.planId);
    }
    return addResearchPlan(projectId, input.plan);
  });
}
