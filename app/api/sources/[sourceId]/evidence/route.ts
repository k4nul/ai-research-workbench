import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { addEvidence } from "@/lib/services/sources";

type Context = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: Context) {
  const { sourceId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) => {
    const body = await request.json();
    return addEvidence({ ...body, sourceId }, principalAuditActor(principal));
  }, { status: 201 });
}
