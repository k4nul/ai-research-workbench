import { handleRoute } from "@/lib/http";
import { addFinding } from "@/lib/services/ledger";
import { query } from "@/lib/db";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    const result = await query(
      "SELECT f.*, COALESCE(array_agg(fc.claim_id) FILTER (WHERE fc.claim_id IS NOT NULL), ARRAY[]::TEXT[]) AS claim_ids FROM findings f LEFT JOIN finding_claims fc ON fc.finding_id = f.id WHERE f.project_id = $1 GROUP BY f.id ORDER BY f.created_at",
      [projectId]
    );
    return result.rows;
  });
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => addFinding(projectId, await request.json()), { status: 201 });
}
