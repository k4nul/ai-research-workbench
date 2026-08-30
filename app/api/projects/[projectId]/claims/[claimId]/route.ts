import { handleRoute } from "@/lib/http";
import { updateClaimReview } from "@/lib/services/ledger";

type Context = { params: Promise<{ projectId: string; claimId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { projectId, claimId } = await context.params;
  return handleRoute(async () =>
    updateClaimReview(projectId, claimId, await request.json())
  );
}
