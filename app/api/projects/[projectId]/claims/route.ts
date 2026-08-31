import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { addClaim, listLedger } from "@/lib/services/ledger";

type Context = { params: Promise<{ projectId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  const unsupportedOnly = new URL(request.url).searchParams.get("unsupported") === "true";
  return handleAuthenticatedRoute(request, () => listLedger(projectId, unsupportedOnly));
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(
    request,
    async (principal) =>
      addClaim(projectId, await request.json(), principalAuditActor(principal)),
    { status: 201 }
  );
}
