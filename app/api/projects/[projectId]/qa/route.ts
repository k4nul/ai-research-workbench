import { handleAuthenticatedRoute } from "@/lib/http";
import { listQaFindings, runProjectQa } from "@/lib/services/qa";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, () => listQaFindings(projectId));
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, () => runProjectQa(projectId));
}
