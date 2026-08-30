import { handleRoute } from "@/lib/http";
import { getDashboard } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(() => getDashboard());
}
