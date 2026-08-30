import { handleRoute } from "@/lib/http";
import { importSources } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => importSources(projectId, await request.json()), {
    status: 201
  });
}
