import { handleRoute } from "@/lib/http";
import {
  deleteProject,
  getProjectBundle,
  updateProjectScope
} from "@/lib/services/projects";

type Context = { params: Promise<{ projectId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(() => getProjectBundle(projectId));
}

export async function DELETE(_request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    await deleteProject(projectId);
    return { deleted: true, projectId };
  });
}

export async function PATCH(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () =>
    updateProjectScope(projectId, await request.json())
  );
}
