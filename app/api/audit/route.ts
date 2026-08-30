import { handleRoute } from "@/lib/http";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  return handleRoute(async () => {
    const result = projectId
      ? await query(
          "SELECT a.*, p.name AS project_name FROM audit_events a LEFT JOIN research_projects p ON p.id = a.project_id WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT 200",
          [projectId]
        )
      : await query(
          "SELECT a.*, p.name AS project_name FROM audit_events a LEFT JOIN research_projects p ON p.id = a.project_id ORDER BY a.created_at DESC LIMIT 200"
        );
    return result.rows;
  });
}
