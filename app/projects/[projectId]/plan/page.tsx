import { PlanWorkspace } from "@/components/features/plan-workspace";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";

export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const bundle = await loadProjectBundle(projectId);
  return <ProjectPageShell description="Break the core question into reviewable questions, searches, source targets, risks, and completion conditions." project={bundle.project} title="Research plan"><PlanWorkspace constraints={[bundle.project.scope, bundle.project.exclusions ?? "", `Research as of ${bundle.project.research_date}`].filter(Boolean)} plans={bundle.plans} projectId={projectId} questions={bundle.questions} /></ProjectPageShell>;
}
