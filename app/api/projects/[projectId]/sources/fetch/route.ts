import { principalAuditActor } from "@/lib/auth/audit-actor";
import { enforceRateLimit, handleAuthenticatedRoute } from "@/lib/http";
import { fetchAndRegisterSource } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) => {
    enforceRateLimit(request, "source-fetch", 10);
    return fetchAndRegisterSource(
      projectId,
      await request.json(),
      principalAuditActor(principal)
    );
  });
}
