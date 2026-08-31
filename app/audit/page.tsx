import Link from "next/link";

import { compactId, formatDateTime, humanize } from "@/components/features/format";
import type { AuditRecord } from "@/components/features/model";
import { asProjects, asRows } from "@/components/features/model";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { query } from "@/lib/db";
import { listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  await requirePageOperator();
  const { projectId } = await searchParams;
  const [eventsResult, projectValues] = await Promise.all([
    projectId ? query("SELECT a.*, p.name AS project_name FROM audit_events a LEFT JOIN research_projects p ON p.id = a.project_id WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT 200", [projectId]) : query("SELECT a.*, p.name AS project_name FROM audit_events a LEFT JOIN research_projects p ON p.id = a.project_id ORDER BY a.created_at DESC LIMIT 200"),
    listProjects(),
  ]);
  const events = asRows<AuditRecord>(eventsResult.rows);
  const projects = asProjects(projectValues);
  const columns: DataTableColumn<AuditRecord>[] = [
    { id: "time", header: "Timestamp", cell: (event) => formatDateTime(event.created_at) },
    { id: "project", header: "Project", cell: (event) => event.project_id ? <Link href={`/projects/${encodeURIComponent(event.project_id)}`}>{event.project_name ?? compactId(event.project_id)}</Link> : "Workspace" },
    { id: "actor", header: "Actor", cell: (event) => <div className="table-primary"><strong>{event.actor_label}</strong><span><StatusBadge showDot={false} status={event.actor_type} /></span></div> },
    { id: "action", header: "Action", cell: (event) => <div className="table-primary"><strong>{humanize(event.action)}</strong><span>{humanize(event.resource_type)} · {compactId(event.resource_id)}</span></div> },
    { id: "change", header: "Recorded change", cell: (event) => event.before_state || event.after_state ? <details className="audit-detail"><summary>Inspect state</summary>{event.before_state ? <><strong>Before</strong><pre>{JSON.stringify(event.before_state, null, 2)}</pre></> : null}{event.after_state ? <><strong>After</strong><pre>{JSON.stringify(event.after_state, null, 2)}</pre></> : null}</details> : "Event only" },
  ];
  return (
    <PageShell description="Inspect up to 200 recent user, provider, and system events with recorded before-and-after state." title="Audit log">
      <div className="page-stack">
        <form aria-label="Audit filters" className="filter-toolbar" method="get"><div className="filter-toolbar__controls"><label className="field field--inline"><span>Project</span><select className="ui-select" defaultValue={projectId ?? ""} name="projectId"><option value="">All projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="ui-button ui-button--secondary" type="submit">Apply filter</button>{projectId ? <Link className="filter-toolbar__clear" href="/audit">Clear filter</Link> : null}</div><div className="filter-toolbar__meta"><span className="filter-toolbar__summary">{events.length} event{events.length === 1 ? "" : "s"}</span></div></form>
        <section className="section-card section-card--flush"><DataTable caption="Workspace audit events" columns={columns} emptyState={<EmptyState compact title="No audit events" description="Project and workflow changes will appear here." />} getRowKey={(event) => event.id} rows={events} /></section>
      </div>
    </PageShell>
  );
}
