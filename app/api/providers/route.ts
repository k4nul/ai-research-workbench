import { handleRoute } from "@/lib/http";
import { getProviderStatuses } from "@/lib/services/provider-runs";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => getProviderStatuses());
}
