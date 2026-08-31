import { ArrowRight, BookOpen, CircleCheckBig, FileText, SearchCheck } from "lucide-react";
import Link from "next/link";

import { formatDate, formatDateTime, humanize } from "@/components/features/format";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";
import { DataTable, EmptyState, KpiCard, ProgressBar, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function ProjectOverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const bundle = await loadProjectBundle(projectId);
  const openQa = bundle.qaFindings.filter((finding) => finding.resolution_status === "OPEN");
  const openGaps = bundle.questions.filter((question) => question.gap_status === "OPEN");
  const unsupported = bundle.claims.filter((claim) => claim.include_in_report && ["UNSUPPORTED", "NOT_VERIFIABLE"].includes(claim.support_status));
  const activityColumns: DataTableColumn<(typeof bundle.auditEvents)[number]>[] = [
    { id: "time", header: "Time", cell: (event) => formatDateTime(event.created_at) },
    { id: "event", header: "Event", cell: (event) => <div className="table-primary"><strong>{humanize(event.action)}</strong><span>{event.actor_label} · {humanize(event.resource_type)}</span></div> },
  ];
  const nextHref = bundle.project.status === "INTAKE" || bundle.project.status === "SCOPING" ? `/projects/${projectId}/scope` : bundle.project.status === "PLANNING" ? `/projects/${projectId}/plan` : bundle.project.status === "RESEARCHING" ? `/projects/${projectId}/sources` : bundle.project.status === "SYNTHESIZING" ? `/projects/${projectId}/report` : bundle.project.status === "QA" ? `/projects/${projectId}/qa` : `/projects/${projectId}/approval`;

  return (
    <ProjectPageShell actions={<Link className="ui-link-button" href={nextHref}>Continue workflow <ArrowRight aria-hidden="true" /></Link>} description={bundle.project.core_question} project={bundle.project} title="Project overview">
      <div className="page-stack">
        <section className="section-card project-summary">
          <div className="project-summary__main"><p className="eyebrow">Research purpose</p><h2>{bundle.project.purpose}</h2><p>{bundle.project.scope}</p></div>
          <dl className="definition-grid"><div><dt>Client</dt><dd>{bundle.project.client_name ?? "Not specified"}</dd></div><div><dt>Audience</dt><dd>{bundle.project.audience}</dd></div><div><dt>Research as of</dt><dd>{formatDate(bundle.project.research_date)}</dd></div><div><dt>Deadline</dt><dd>{formatDate(bundle.project.deadline)}</dd></div><div><dt>Approval</dt><dd><StatusBadge status={bundle.project.approval_status} /></dd></div><div><dt>Updated</dt><dd>{formatDateTime(bundle.project.updated_at)}</dd></div></dl>
          <ProgressBar label="Strict workflow evidence completed" value={bundle.project.progress} />
        </section>
        <section aria-label="Project record counts" className="metric-grid">
          <KpiCard detail={`${openGaps.length} open gap${openGaps.length === 1 ? "" : "s"}`} href={`/projects/${projectId}/plan`} icon={<BookOpen />} label="Questions" tone={openGaps.length ? "warning" : "info"} value={bundle.questions.length} />
          <KpiCard detail={`${bundle.evidence.length} evidence excerpt${bundle.evidence.length === 1 ? "" : "s"}`} href={`/projects/${projectId}/sources`} icon={<SearchCheck />} label="Sources" tone="info" value={bundle.sources.length} />
          <KpiCard detail={`${unsupported.length} unsupported included`} href={`/projects/${projectId}/ledger`} icon={<CircleCheckBig />} label="Claims" tone={unsupported.length ? "danger" : "success"} value={bundle.claims.length} />
          <KpiCard detail={`${openQa.length} open QA finding${openQa.length === 1 ? "" : "s"}`} href={`/projects/${projectId}/qa`} icon={<FileText />} label="Findings" tone={openQa.length ? "warning" : "success"} value={bundle.findings.length} />
        </section>
        <section className="section-card"><div className="section-heading"><div><h2>Recent project activity</h2><p>Latest changes recorded for traceability.</p></div><Link className="text-link" href={`/audit?projectId=${encodeURIComponent(projectId)}`}>Full audit log</Link></div><DataTable caption="Recent project audit activity" columns={activityColumns} emptyState={<EmptyState compact title="No project activity" description="Changes will be recorded here." />} getRowKey={(event) => event.id} rows={bundle.auditEvents.slice(0, 10)} /></section>
      </div>
    </ProjectPageShell>
  );
}
