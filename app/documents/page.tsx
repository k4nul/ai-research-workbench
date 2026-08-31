import { asProjects } from "@/components/features/model";
import { PageShell } from "@/components/features/page-shell";
import { DocumentsBrowser } from "@/components/operations/documents-browser";
import { requirePageOperator } from "@/lib/auth/dal";
import { listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  await requirePageOperator();
  const projects = asProjects(await listProjects()).map((project) => ({
    id: project.id,
    name: project.name
  }));

  return (
    <PageShell
      description="Review project-scoped upload, malware scan, and extraction state without exposing document contents."
      title="Documents"
    >
      <DocumentsBrowser projects={projects} />
    </PageShell>
  );
}
