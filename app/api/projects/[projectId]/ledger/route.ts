import { handleRoute } from "@/lib/http";
import { linkClaimEvidence, listLedger } from "@/lib/services/ledger";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  const unsupportedOnly = new URL(request.url).searchParams.get("unsupported") === "true";
  return handleRoute(() => listLedger(projectId, unsupportedOnly));
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => linkClaimEvidence(projectId, await request.json()));
}
