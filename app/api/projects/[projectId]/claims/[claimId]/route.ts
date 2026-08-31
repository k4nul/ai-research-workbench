import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { updateClaimReview } from "@/lib/services/ledger";

type Context = { params: Promise<{ projectId: string; claimId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { projectId, claimId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) =>
    updateClaimReview(
      projectId,
      claimId,
      await request.json(),
      principalAuditActor(principal)
    )
  );
}
