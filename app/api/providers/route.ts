import { handleAuthenticatedRoute } from "@/lib/http";
import { getProviderStatuses } from "@/lib/services/provider-runs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => getProviderStatuses());
}
