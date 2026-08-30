import { handleRoute } from "@/lib/http";
import {
  getCurrentDeliverable,
  getDeliverableHistory,
  updateDeliverable
} from "@/lib/services/reports";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => ({
    deliverable: await getCurrentDeliverable(projectId),
    history: await getDeliverableHistory(projectId)
  }));
}

export async function PUT(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => updateDeliverable(projectId, await request.json()));
}
