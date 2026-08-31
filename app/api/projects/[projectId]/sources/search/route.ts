import { principalAuditActor } from "@/lib/auth/audit-actor";
import { enforceRateLimit, handleAuthenticatedRoute } from "@/lib/http";
import { requestIdempotencyKey } from "@/lib/operations/request";
import { searchAndRegisterSources } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) => {
    const idempotencyKey = requestIdempotencyKey(request);
    enforceRateLimit(request, "source-search", 10);
    return searchAndRegisterSources(
      projectId,
      await request.json(),
      principalAuditActor(principal),
      idempotencyKey
    );
  });
}
