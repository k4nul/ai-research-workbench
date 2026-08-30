import { enforceRateLimit, handleRoute } from "@/lib/http";
import { fetchAndRegisterSource } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    enforceRateLimit(request, "source-fetch", 10);
    return fetchAndRegisterSource(projectId, await request.json());
  });
}
