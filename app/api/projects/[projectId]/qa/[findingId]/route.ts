import { z } from "zod";
import { handleRoute } from "@/lib/http";
import { resolveQaFinding } from "@/lib/services/qa";

type Context = {
  params: Promise<{ projectId: string; findingId: string }>;
};

const schema = z.object({
  resolutionStatus: z.enum(["RESOLVED", "ACCEPTED_RISK"])
});

export async function PATCH(request: Request, context: Context) {
  const { projectId, findingId } = await context.params;
  return handleRoute(async () => {
    const input = schema.parse(await request.json());
    return resolveQaFinding(projectId, findingId, input.resolutionStatus);
  });
}
