import { handleRoute } from "@/lib/http";
import { listQaFindings, runProjectQa } from "@/lib/services/qa";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(() => listQaFindings(projectId));
}

export async function POST(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(() => runProjectQa(projectId));
}
