import { enforceRateLimit, handleRoute } from "@/lib/http";
import { searchAndRegisterSources } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  enforceRateLimit(request, "source-search", 10);
  const { projectId } = await context.params;
  return handleRoute(async () =>
    searchAndRegisterSources(projectId, await request.json())
  );
}
