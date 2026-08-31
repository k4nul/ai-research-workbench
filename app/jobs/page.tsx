import Link from "next/link";

import { compactId, formatDateTime, humanize } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { OperationAction } from "@/components/operations/operation-action";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { JOB_STATUSES, type JobStatus } from "@/lib/domain/jobs";
import { listJobs, type JobOperationsRow } from "@/lib/services/operations";

export const dynamic = "force-dynamic";

export default async function JobsPage({
  searchParams
}: {
  searchParams: Promise<{ projectId?: string; status?: string }>;
}) {
  await requirePageOperator();
  const filters = await searchParams;
  const status = JOB_STATUSES.includes(filters.status as JobStatus)
    ? (filters.status as JobStatus)
    : undefined;
  const jobs = await listJobs({ projectId: filters.projectId || undefined, status, limit: 200 });
  const columns: DataTableColumn<JobOperationsRow>[] = [
    {
      id: "job",
      header: "Job",
      cell: (job) => (
        <div className="table-primary">
          <Link href={`/jobs/${encodeURIComponent(job.id)}`}>{job.job_type}</Link>
          <span>{compactId(job.id)} · {job.stage ? humanize(job.stage) : "No stage"}</span>
        </div>
      )
    },
    {
      id: "project",
      header: "Project",
      cell: (job) => job.project_id ? <Link href={`/projects/${encodeURIComponent(job.project_id)}`}>{job.project_name ?? compactId(job.project_id)}</Link> : "System"
    },
    { id: "status", header: "Status", cell: (job) => <StatusBadge status={job.status} /> },
    { id: "attempts", header: "Attempts", align: "right", cell: (job) => `${job.attempts}/${job.max_attempts}` },
    { id: "scheduled", header: "Scheduled", cell: (job) => formatDateTime(job.scheduled_at.toISOString()) },
    {
      id: "actions",
      header: "Action",
      cell: (job) => {
        const projectId =
          job.project_id ?? (job.job_type === "STORAGE_CLEANUP" ? null : undefined);
        if (projectId === undefined) return "Project scope unavailable";
        if (["FAILED", "DEAD_LETTER"].includes(job.status)) {
          return <OperationAction endpoint={`/api/jobs/${encodeURIComponent(job.id)}/retry`} label="Retry" projectId={projectId} successMessage="Job returned to the queue." />;
        }
        if (["QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT"].includes(job.status)) {
          return <OperationAction dangerous endpoint={`/api/jobs/${encodeURIComponent(job.id)}/cancel`} label="Cancel" projectId={projectId} successMessage="Cancellation recorded." />;
        }
        return "No action available";
      }
    }
  ];

  return (
    <PageShell description="Inspect durable queue state, retry eligible failures, and request cooperative cancellation." title="Job queue">
      <div className="page-stack">
        <form aria-label="Job filters" className="filter-toolbar" method="get">
          <div className="filter-toolbar__controls">
            <label className="sr-only" htmlFor="job-status">Job status</label>
            <select defaultValue={status ?? ""} id="job-status" name="status">
              <option value="">All statuses</option>
              {JOB_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
            </select>
            <label className="filter-search"><span className="sr-only">Project ID</span><input defaultValue={filters.projectId ?? ""} name="projectId" placeholder="Project ID" /></label>
            <button className="ui-button ui-button--secondary" type="submit">Apply filters</button>
            {status || filters.projectId ? <Link className="filter-toolbar__clear" href="/jobs">Clear filters</Link> : null}
          </div>
          <div className="filter-toolbar__meta"><span className="filter-toolbar__summary">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span></div>
        </form>
        <section className="section-card section-card--flush">
          <DataTable caption="Durable jobs" columns={columns} emptyState={<EmptyState compact title="No matching jobs" description="The queue has no jobs matching these filters." />} getRowKey={(job) => job.id} rows={jobs} />
        </section>
      </div>
    </PageShell>
  );
}
