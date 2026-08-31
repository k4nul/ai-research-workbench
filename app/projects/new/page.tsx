import { ProjectCreateForm } from "@/components/features/project-create-form";
import { PageShell } from "@/components/features/page-shell";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  await requirePageOperator();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <PageShell description="Capture the decision, question, boundaries, freshness rules, and requested formats before research begins." eyebrow="Project intake" title="Create project">
      <ProjectCreateForm today={today} />
    </PageShell>
  );
}
