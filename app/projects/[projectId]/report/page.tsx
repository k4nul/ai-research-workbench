import { formatDateTime } from "@/components/features/format";
import { asRows, type DeliverableRecord } from "@/components/features/model";
import { ProjectPageShell } from "@/components/features/page-shell";
import { ReportEditor } from "@/components/features/report-editor";
import { loadProject } from "@/components/features/server-data";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { getCurrentDeliverable, getDeliverableHistory } from "@/lib/services/reports";

export const dynamic = "force-dynamic";

interface RevisionRecord {
  id: string;
  actor_type: string;
  changed_sections: string[];
  created_at: string;
}

export default async function ReportPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const [project, deliverableValue, historyValue] = await Promise.all([loadProject(projectId), getCurrentDeliverable(projectId), getDeliverableHistory(projectId)]);
  const deliverable = deliverableValue as unknown as DeliverableRecord;
  const history = asRows<RevisionRecord>(historyValue);
  const columns: DataTableColumn<RevisionRecord>[] = [
    { id: "time", header: "Saved", cell: (revision) => formatDateTime(revision.created_at) },
    { id: "actor", header: "Actor", cell: (revision) => <StatusBadge status={revision.actor_type} /> },
    { id: "sections", header: "Changed sections", cell: (revision) => revision.changed_sections?.length ? revision.changed_sections.join(", ") : "No section content changed" },
  ];
  return (
    <ProjectPageShell description={`Edit deliverable version ${deliverable.version}. Every save records the changed sections and actor.`} project={project} title="Report">
      <div className="page-stack">
        <ReportEditor deliverable={deliverable} projectId={projectId} />
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Revision history</h2><p>Latest human and configured-provider revisions.</p></div></div><DataTable caption="Report revision history" columns={columns} emptyState={<EmptyState compact title="No revisions yet" description="The initial deliverable exists; the first save will create a revision record." />} getRowKey={(revision) => revision.id} rows={history} /></section>
      </div>
    </ProjectPageShell>
  );
}
