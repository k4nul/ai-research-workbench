import { handleRoute } from "@/lib/http";
import { addEvidence } from "@/lib/services/sources";

type Context = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: Context) {
  const { sourceId } = await context.params;
  return handleRoute(async () => {
    const body = await request.json();
    return addEvidence({ ...body, sourceId });
  }, { status: 201 });
}
