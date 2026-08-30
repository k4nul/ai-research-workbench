import { enforceRateLimit, handleRoute } from "@/lib/http";
import { searchAndRegisterSources } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    enforceRateLimit(request, "source-search", 10);
    return searchAndRegisterSources(projectId, await request.json());
  });
}
