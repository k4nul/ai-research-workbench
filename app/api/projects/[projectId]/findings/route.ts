import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { addFinding } from "@/lib/services/ledger";
import { query } from "@/lib/db";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async () => {
    const result = await query(
      "SELECT f.*, COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), ARRAY[]::TEXT[]) AS claim_ids FROM findings f LEFT JOIN finding_claims fc ON fc.finding_id = f.id LEFT JOIN claims c ON c.id = fc.claim_id AND c.is_current = TRUE WHERE f.project_id = $1 AND f.is_current = TRUE GROUP BY f.id ORDER BY f.created_at",
      [projectId]
    );
    return result.rows;
  });
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(
    request,
    async (principal) =>
      addFinding(projectId, await request.json(), principalAuditActor(principal)),
    { status: 201 }
  );
}
