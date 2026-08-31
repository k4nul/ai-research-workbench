import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { createProject, listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handleAuthenticatedRoute(request, () =>
    listProjects({
      status: url.searchParams.get("status") || undefined,
      queryText: url.searchParams.get("q") || undefined
    })
  );
}

export async function POST(request: Request) {
  return handleAuthenticatedRoute(
    request,
    async (principal) =>
      createProject(await request.json(), principalAuditActor(principal)),
    { status: 201 }
  );
}
