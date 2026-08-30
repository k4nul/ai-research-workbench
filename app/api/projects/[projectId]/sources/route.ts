import { handleRoute } from "@/lib/http";
import { addSource } from "@/lib/services/sources";
import { query } from "@/lib/db";

type Context = { params: Promise<{ projectId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    const result = await query(
      "SELECT s.*, COUNT(e.id)::int AS evidence_count FROM sources s LEFT JOIN evidence e ON e.source_id = s.id WHERE s.project_id = $1 GROUP BY s.id ORDER BY s.accessed_at DESC",
      [projectId]
    );
    return result.rows;
  });
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => addSource(projectId, await request.json()), { status: 201 });
}
