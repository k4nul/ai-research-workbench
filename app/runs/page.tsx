import Link from "next/link";

import { compactId, formatDateTime, humanize } from "@/components/features/format";
import { asProjects } from "@/components/features/model";
import { PageShell } from "@/components/features/page-shell";
import { OperationAction } from "@/components/operations/operation-action";
import { RunCreateForm } from "@/components/operations/run-create-form";
import { DataTable, EmptyState, ProgressBar, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { RESEARCH_RUN_STATUSES, type ResearchRunStatus } from "@/lib/domain/research-runs";
import { listResearchRuns, type ResearchRunOperationsRow } from "@/lib/services/operations";
import { listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

export default async function RunsPage({
  searchParams
}: {
  searchParams: Promise<{ projectId?: string; status?: string }>;
}) {
  await requirePageOperator();
  const filters = await searchParams;
  const status = RESEARCH_RUN_STATUSES.includes(filters.status as ResearchRunStatus)
    ? (filters.status as ResearchRunStatus)
    : undefined;
  const [runs, projectsValue] = await Promise.all([
    listResearchRuns({ projectId: filters.projectId || undefined, status, limit: 200 }),
    listProjects()
  ]);
  const approvedProjects = asProjects(projectsValue)
    .filter((project) => project.scope_approved_at && project.plan_approved_at)
    .map((project) => ({ id: project.id, name: project.name, status: project.status }));
  const columns: DataTableColumn<ResearchRunOperationsRow>[] = [
    {
      id: "run",
      header: "Run",
      cell: (run) => <div className="table-primary"><Link href={`/runs/${encodeURIComponent(run.id)}`}>{run.project_name}</Link><span>{compactId(run.id)} · {humanize(run.mode)}</span></div>
    },
    { id: "status", header: "Status", cell: (run) => <StatusBadge status={run.status} /> },
    { id: "stage", header: "Current stage", cell: (run) => run.current_stage ? humanize(run.current_stage) : "Not started" },
    { id: "progress", header: "Progress", cell: (run) => <ProgressBar compact label={`${run.project_name} run progress`} value={run.progress} /> },
    { id: "updated", header: "Updated", cell: (run) => formatDateTime(run.updated_at.toISOString()) },
    {
      id: "action",
      header: "Action",
      cell: (run) => ["CANCELLED", "FAILED", "PAUSED", "BLOCKED"].includes(run.status)
        ? <OperationAction endpoint={`/api/runs/${encodeURIComponent(run.id)}/resume`} label="Resume" projectId={run.project_id} successMessage="Run returned to the queue." />
        : ["QUEUED", "RUNNING"].includes(run.status)
          ? <OperationAction dangerous endpoint={`/api/runs/${encodeURIComponent(run.id)}/cancel`} label="Cancel" projectId={run.project_id} successMessage="Run cancellation recorded." />
          : "No action available"
    }
  ];

  return (
    <PageShell description="Create, monitor, cancel, resume, and inspect versioned research pipelines." title="Research runs">
      <div className="page-stack">
        <section className="section-card"><div className="section-heading"><div><h2>Create durable run</h2><p>Only projects with approved scope and plans are available.</p></div></div><RunCreateForm projects={approvedProjects} /></section>
        <form aria-label="Run filters" className="filter-toolbar" method="get">
          <div className="filter-toolbar__controls">
            <label className="sr-only" htmlFor="run-status">Run status</label>
            <select defaultValue={status ?? ""} id="run-status" name="status"><option value="">All statuses</option>{RESEARCH_RUN_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select>
            <label className="filter-search"><span className="sr-only">Project ID</span><input defaultValue={filters.projectId ?? ""} name="projectId" placeholder="Project ID" /></label>
            <button className="ui-button ui-button--secondary" type="submit">Apply filters</button>
            {status || filters.projectId ? <Link className="filter-toolbar__clear" href="/runs">Clear filters</Link> : null}
          </div>
          <div className="filter-toolbar__meta"><span className="filter-toolbar__summary">{runs.length} run{runs.length === 1 ? "" : "s"}</span></div>
        </form>
        <section className="section-card section-card--flush"><DataTable caption="Research runs" columns={columns} emptyState={<EmptyState compact title="No matching runs" description="Create a run from an approved project or change the filters." />} getRowKey={(run) => run.id} rows={runs} /></section>
      </div>
    </PageShell>
  );
}
