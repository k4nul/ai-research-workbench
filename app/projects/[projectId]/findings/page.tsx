import { FindingForm } from "@/components/features/finding-form";
import { formatDateTime } from "@/components/features/format";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function FindingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const bundle = await loadProjectBundle(projectId);
  const columns: DataTableColumn<(typeof bundle.findings)[number]>[] = [
    { id: "finding", header: "Finding", cell: (finding) => <div className="table-primary"><strong>{finding.finding}</strong><span>{finding.impact ?? "No impact statement"}</span></div> },
    { id: "importance", header: "Importance", cell: (finding) => <StatusBadge status={finding.importance} /> },
    { id: "claims", header: "Claims", align: "right", cell: (finding) => finding.claim_ids?.length ?? 0 },
    { id: "recommendation", header: "Recommendation", cell: (finding) => finding.can_inform_recommendation ? "May inform" : "Finding only" },
    { id: "limitations", header: "Limitations", cell: (finding) => finding.limitations ?? "None recorded" },
    { id: "created", header: "Created", cell: (finding) => formatDateTime(finding.created_at) },
  ];
  return (
    <ProjectPageShell description="Synthesize supported claims into decision-relevant findings without hiding limitations." project={bundle.project} title="Findings">
      <div className="page-stack"><FindingForm claims={bundle.claims} projectId={projectId} questions={bundle.questions} /><section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Finding register</h2><p>Findings remain connected to their supporting claim IDs.</p></div></div><DataTable caption="Project findings" columns={columns} emptyState={<EmptyState compact title="No findings yet" description="Create claims and link evidence before synthesizing conclusions." />} getRowKey={(finding) => finding.id} rows={bundle.findings} /></section></div>
    </ProjectPageShell>
  );
}
