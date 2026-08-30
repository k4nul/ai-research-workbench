import { z } from "zod";
import { handleRoute } from "@/lib/http";
import { reuseSource } from "@/lib/services/sources";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    const input = z.object({ sourceId: z.string().min(1) }).parse(await request.json());
    return reuseSource(projectId, input.sourceId);
  }, { status: 201 });
}
