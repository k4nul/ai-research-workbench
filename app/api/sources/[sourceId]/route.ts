import { handleAuthenticatedRoute } from "@/lib/http";
import { getSource } from "@/lib/services/sources";

type Context = { params: Promise<{ sourceId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const { sourceId } = await context.params;
  return handleAuthenticatedRoute(request, () => getSource(sourceId));
}
