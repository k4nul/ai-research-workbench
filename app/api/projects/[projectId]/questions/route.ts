import { handleRoute } from "@/lib/http";
import { addResearchQuestion } from "@/lib/services/workflow";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => addResearchQuestion(projectId, await request.json()), { status: 201 });
}
