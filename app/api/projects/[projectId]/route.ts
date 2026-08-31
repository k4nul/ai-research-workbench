import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import {
  deleteProject,
  getProjectBundle,
  updateProjectScope
} from "@/lib/services/projects";

type Context = { params: Promise<{ projectId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, () => getProjectBundle(projectId));
}

export async function DELETE(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) => {
    const deletion = await deleteProject(projectId, principalAuditActor(principal));
    return { deleted: true, projectId, ...deletion };
  });
}

export async function PATCH(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async (principal) =>
    updateProjectScope(
      projectId,
      await request.json(),
      principalAuditActor(principal)
    )
  );
}
