import { z } from "zod";
import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { reuseSource } from "@/lib/services/sources";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) => {
    const input = z.object({ sourceId: z.string().min(1) }).parse(await request.json());
    return reuseSource(projectId, input.sourceId, principalAuditActor(principal));
  }, { status: 201 });
}
