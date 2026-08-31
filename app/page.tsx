import { Activity, AlertTriangle, CalendarClock, CircleCheckBig, FolderKanban, Link2Off } from "lucide-react";
import Link from "next/link";

import { formatDate, formatDateTime, humanize } from "@/components/features/format";
import { asDashboard } from "@/components/features/model";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, EmptyState, KpiCard, ProgressBar, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { getDashboard } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requirePageOperator();
  const dashboard = asDashboard(await getDashboard());
  const projectColumns: DataTableColumn<(typeof dashboard.projects)[number]>[] = [
    { id: "project", header: "Project", cell: (project) => <div className="table-primary"><Link href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</Link><span>{project.core_question}</span></div> },
    { id: "status", header: "Status", cell: (project) => <StatusBadge status={project.status} /> },
    { id: "progress", header: "Progress", cell: (project) => <ProgressBar compact label={`${project.name} completion`} value={project.progress} /> },
    { id: "deadline", header: "Deadline", cell: (project) => formatDate(project.deadline) },
    { id: "updated", header: "Updated", cell: (project) => formatDateTime(project.updated_at) },
  ];
  const activityColumns: DataTableColumn<(typeof dashboard.recentActivity)[number]>[] = [
    { id: "time", header: "Time", cell: (event) => formatDateTime(event.created_at) },
    { id: "project", header: "Project", cell: (event) => event.project_id ? <Link href={`/projects/${encodeURIComponent(event.project_id)}`}>{event.project_name ?? event.project_id}</Link> : "Workspace" },
    { id: "action", header: "Event", cell: (event) => <div className="table-primary"><strong>{humanize(event.action)}</strong><span>{event.actor_label} · {humanize(event.resource_type)}</span></div> },
  ];

  return (
    <PageShell
      actions={<Link className="ui-link-button" href="/projects/new">New project</Link>}
      description="Monitor deadlines, evidence gaps, QA blockers, and approvals across active research."
      title="Dashboard"
    >
      <div className="page-stack">
        <section aria-label="Workspace metrics" className="metric-grid metric-grid--six">
          <KpiCard detail="Not delivered or archived" href="/projects" icon={<FolderKanban />} label="Active projects" tone="info" value={dashboard.metrics.activeProjects} />
          <KpiCard detail="Within the next 7 days" href="/projects" icon={<CalendarClock />} label="Due soon" tone={dashboard.metrics.dueSoon ? "warning" : "neutral"} value={dashboard.metrics.dueSoon} />
          <KpiCard detail="Open blocker findings" href="/projects?status=QA" icon={<AlertTriangle />} label="QA blocked" tone={dashboard.metrics.qaBlocked ? "danger" : "success"} value={dashboard.metrics.qaBlocked} />
          <KpiCard detail="Pending human decision" href="/projects?status=APPROVAL_REQUIRED" icon={<CircleCheckBig />} label="Awaiting approval" tone={dashboard.metrics.awaitingApproval ? "warning" : "neutral"} value={dashboard.metrics.awaitingApproval} />
          <KpiCard detail="Unresolved research gaps" href="/projects" icon={<Activity />} label="Open gaps" tone={dashboard.metrics.openGaps ? "warning" : "success"} value={dashboard.metrics.openGaps} />
          <KpiCard detail="Included without support" href="/projects" icon={<Link2Off />} label="Unsupported claims" tone={dashboard.metrics.unsupportedClaims ? "danger" : "success"} value={dashboard.metrics.unsupportedClaims} />
        </section>

        <section className="section-card">
          <div className="section-heading"><div><h2>Recent projects</h2><p>Ordered by most recent change.</p></div><Link className="text-link" href="/projects">View all projects</Link></div>
          <DataTable caption="Recent projects" columns={projectColumns} emptyState={<EmptyState compact title="No projects yet" description="Create a project to begin the evidence-first workflow." action={<Link className="ui-link-button" href="/projects/new">Create project</Link>} />} getRowKey={(project) => project.id} rows={dashboard.projects.slice(0, 8)} />
        </section>

        <section className="section-card">
          <div className="section-heading"><div><h2>Recent activity</h2><p>Recorded workspace and project events.</p></div><Link className="text-link" href="/audit">Open audit log</Link></div>
          <DataTable caption="Recent audit activity" columns={activityColumns} emptyState={<EmptyState compact title="No activity recorded" description="Actions will appear after a project is created or changed." />} getRowKey={(event) => event.id} rows={dashboard.recentActivity} />
        </section>
      </div>
    </PageShell>
  );
}
