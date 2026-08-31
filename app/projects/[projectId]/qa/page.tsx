import { PlayCircle } from "lucide-react";

import { formatDateTime } from "@/components/features/format";
import { asRows, type QaFindingRecord } from "@/components/features/model";
import { ApiActionButton } from "@/components/features/mutation-ui";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProject } from "@/components/features/server-data";
import { DataTable, EmptyState, SeverityBadge, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { listQaFindings } from "@/lib/services/qa";

export const dynamic = "force-dynamic";

export default async function QaPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const [project, findingValue] = await Promise.all([loadProject(projectId), listQaFindings(projectId)]);
  const findings = asRows<QaFindingRecord>(findingValue);
  const columns: DataTableColumn<QaFindingRecord>[] = [
    { id: "severity", header: "Severity", cell: (finding) => <SeverityBadge severity={finding.severity} /> },
    { id: "finding", header: "Finding", cell: (finding) => <div className="table-primary"><strong>{finding.problem}</strong><span>{finding.rule_code} · {finding.location}</span><span>Remediation: {finding.remediation}</span></div> },
    { id: "status", header: "Resolution", cell: (finding) => <StatusBadge status={finding.resolution_status} /> },
    { id: "created", header: "Detected", cell: (finding) => formatDateTime(finding.created_at) },
    { id: "actions", header: "Actions", cell: (finding) => finding.resolution_status === "OPEN" ? <div className="table-actions"><ApiActionButton body={{ resolutionStatus: "RESOLVED" }} className="ui-button ui-button--secondary" endpoint={`/api/projects/${encodeURIComponent(projectId)}/qa/${encodeURIComponent(finding.id)}`} label="Resolve" method="PATCH" successMessage="QA finding resolved." />{finding.severity !== "BLOCKER" ? <ApiActionButton body={{ resolutionStatus: "ACCEPTED_RISK" }} className="ui-button ui-button--secondary" endpoint={`/api/projects/${encodeURIComponent(projectId)}/qa/${encodeURIComponent(finding.id)}`} label="Accept risk" method="PATCH" successMessage="Risk acceptance recorded." /> : null}</div> : "Recorded" },
  ];
  const unresolvedBlockers = findings.filter((finding) => finding.severity === "BLOCKER" && finding.resolution_status !== "RESOLVED").length;
  return (
    <ProjectPageShell actions={<ApiActionButton body={{}} endpoint={`/api/projects/${encodeURIComponent(projectId)}/qa`} label="Run QA" pendingLabel="Running QA…" successMessage="QA run completed and findings refreshed." />} description="Run deterministic quality rules, resolve failures, and keep blocker decisions explicit." project={project} title="Quality assurance">
      <div className="page-stack">
        <section className={`notice ${unresolvedBlockers ? "notice--danger" : "notice--success"}`}><PlayCircle aria-hidden="true" /><div><strong>{unresolvedBlockers ? `${unresolvedBlockers} unresolved blocker${unresolvedBlockers === 1 ? "" : "s"}` : "No unresolved blockers in the current finding set"}</strong><p>A fresh QA run is required after material report or evidence changes. Approval also requires a recorded passing run.</p></div></section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>QA findings</h2><p>Blockers must be resolved; accepting blocker risk does not clear the approval gate.</p></div></div><DataTable caption="Quality assurance findings" columns={columns} emptyState={<EmptyState compact title="No QA findings recorded" description="Create and save a report, then run QA to populate this view." />} getRowKey={(finding) => finding.id} rows={findings} /></section>
      </div>
    </ProjectPageShell>
  );
}
