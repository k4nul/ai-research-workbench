import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { importSources } from "@/lib/services/ingestion";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(
    request,
    async (principal) =>
      importSources(
        projectId,
        await request.json(),
        principalAuditActor(principal)
      ),
    { status: 201 }
  );
}
