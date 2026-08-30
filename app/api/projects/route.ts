import { handleRoute } from "@/lib/http";
import { createProject, listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handleRoute(() =>
    listProjects({
      status: url.searchParams.get("status") || undefined,
      queryText: url.searchParams.get("q") || undefined
    })
  );
}

export async function POST(request: Request) {
  return handleRoute(async () => createProject(await request.json()), { status: 201 });
}
