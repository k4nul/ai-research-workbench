import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  getCurrentDeliverable,
  getDeliverableHistory,
  updateDeliverable
} from "@/lib/services/reports";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async () => ({
    deliverable: await getCurrentDeliverable(projectId),
    history: await getDeliverableHistory(projectId)
  }));
}

export async function PUT(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) =>
    updateDeliverable(
      projectId,
      await request.json(),
      principalAuditActor(principal)
    )
  );
}
