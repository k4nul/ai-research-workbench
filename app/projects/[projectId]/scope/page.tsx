import { ScopeEditor } from "@/components/features/scope-editor";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProject } from "@/components/features/server-data";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function ScopePage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const project = await loadProject(projectId);
  return <ProjectPageShell description="Define what the research will answer, for whom, and under which time and jurisdiction constraints." project={project} title="Scope"><ScopeEditor project={project} /></ProjectPageShell>;
}
