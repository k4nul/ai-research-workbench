import { handleAuthenticatedRoute } from "@/lib/http";
import { getDashboard } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, () => getDashboard());
}
