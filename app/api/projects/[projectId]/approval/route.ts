import { z } from "zod";
import { handleRoute } from "@/lib/http";
import { runApprovalAction } from "@/lib/services/approval";

type Context = { params: Promise<{ projectId: string }> };

const schema = z.object({
  action: z.enum(["request", "approve", "deliver"]),
  confirmation: z.boolean().default(false)
});

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    const input = schema.parse(await request.json());
    return runApprovalAction(projectId, input.action, input.confirmation);
  });
}
