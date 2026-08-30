import { handleRoute } from "@/lib/http";
import { approveScope } from "@/lib/services/projects";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(() => approveScope(projectId));
}
