import { enforceRateLimit, handleRoute } from "@/lib/http";
import { fetchAndRegisterSource } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  enforceRateLimit(request, "source-fetch", 10);
  const { projectId } = await context.params;
  return handleRoute(async () =>
    fetchAndRegisterSource(projectId, await request.json())
  );
}
