import Link from "next/link";

import { compactId, formatDateTime, humanize } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { OperationAction } from "@/components/operations/operation-action";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import {
  getJobOperationsDetail,
  type JobAttemptOperationsRow,
  type JobEventOperationsRow
} from "@/lib/services/operations";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requirePageOperator();
  const { jobId } = await params;
  const detail = await getJobOperationsDetail(jobId);
  const job = detail.job;
  const attemptColumns: DataTableColumn<JobAttemptOperationsRow>[] = [
    { id: "attempt", header: "Attempt", align: "right", cell: (attempt) => attempt.attempt_number },
    { id: "status", header: "Status", cell: (attempt) => <StatusBadge status={attempt.status} /> },
    { id: "worker", header: "Worker", cell: (attempt) => compactId(attempt.worker_id) },
    { id: "started", header: "Started", cell: (attempt) => formatDateTime(attempt.started_at.toISOString()) },
    { id: "error", header: "Safe error", cell: (attempt) => attempt.sanitized_error ?? "None" }
  ];
  const eventColumns: DataTableColumn<JobEventOperationsRow>[] = [
    { id: "time", header: "Time", cell: (event) => formatDateTime(event.created_at.toISOString()) },
    { id: "event", header: "Event", cell: (event) => humanize(event.event_type) },
    { id: "transition", header: "Transition", cell: (event) => event.from_status || event.to_status ? `${event.from_status ?? "—"} → ${event.to_status ?? "—"}` : "No status change" },
    { id: "worker", header: "Worker", cell: (event) => compactId(event.worker_id) }
  ];
  const canRetry = ["FAILED", "DEAD_LETTER"].includes(job.status);
  const canCancel = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT"].includes(job.status);
  const actionProjectId =
    job.project_id ?? (job.job_type === "STORAGE_CLEANUP" ? null : undefined);

  return (
    <PageShell
      actions={<Link className="ui-link-button ui-link-button--secondary" href="/jobs">Back to queue</Link>}
      description={`${job.job_type} · ${job.project_name ?? "System-scoped job"}`}
      eyebrow="Durable execution"
      title={`Job ${compactId(job.id)}`}
    >
      <div className="page-stack">
        <section className="section-card">
          <div className="section-heading"><div><h2>Current state</h2><p>Payloads are intentionally omitted from this operator view.</p></div><StatusBadge status={job.status} /></div>
          <dl className="definition-grid">
            <div><dt>Project</dt><dd>{job.project_id ? <Link href={`/projects/${encodeURIComponent(job.project_id)}`}>{job.project_name ?? compactId(job.project_id)}</Link> : "System"}</dd></div>
            <div><dt>Stage</dt><dd>{job.stage ? humanize(job.stage) : "Not assigned"}</dd></div>
            <div><dt>Attempts</dt><dd>{job.attempts} of {job.max_attempts}</dd></div>
            <div><dt>Input hash</dt><dd><code>{compactId(job.input_hash)}</code></dd></div>
            <div><dt>Output hash</dt><dd><code>{compactId(job.output_hash)}</code></dd></div>
            <div><dt>Updated</dt><dd>{formatDateTime(job.updated_at.toISOString())}</dd></div>
          </dl>
          {job.sanitized_error ? <div className="notice notice--danger"><p>{job.sanitized_error}</p></div> : null}
          {actionProjectId !== undefined && (canRetry || canCancel) ? (
            <div className="form-actions">
              {canRetry ? <OperationAction endpoint={`/api/jobs/${encodeURIComponent(job.id)}/retry`} label="Retry job" projectId={actionProjectId} successMessage="Job returned to the queue." /> : null}
              {canCancel ? <OperationAction dangerous endpoint={`/api/jobs/${encodeURIComponent(job.id)}/cancel`} label="Cancel job" projectId={actionProjectId} successMessage="Cancellation recorded." /> : null}
            </div>
          ) : null}
        </section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Attempts</h2><p>Lease ownership and sanitized failures for each claim.</p></div></div><DataTable caption="Job attempts" columns={attemptColumns} emptyState={<EmptyState compact title="No attempts" description="This job has not been claimed by a worker." />} getRowKey={(attempt) => attempt.id} rows={detail.attempts} /></section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Event trail</h2><p>Durable queue transitions in reverse chronological order.</p></div></div><DataTable caption="Job event trail" columns={eventColumns} emptyState={<EmptyState compact title="No events" description="No durable events were recorded." />} getRowKey={(event) => event.id} rows={detail.events} /></section>
      </div>
    </PageShell>
  );
}
