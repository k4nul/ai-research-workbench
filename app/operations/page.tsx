import { AlertTriangle, Bot, Clock3, FileWarning, Server, Workflow } from "lucide-react";
import Link from "next/link";

import { formatDateTime } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, EmptyState, KpiCard, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { getOperationalMetrics } from "@/lib/services/operational-metrics";
import { listJobs, listResearchRuns, type JobOperationsRow } from "@/lib/services/operations";
import { listWorkers } from "@/lib/services/workers";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  await requirePageOperator();
  const [metrics, jobs, runs, workers] = await Promise.all([
    getOperationalMetrics(30),
    listJobs({ limit: 10 }),
    listResearchRuns({ limit: 8 }),
    listWorkers(30)
  ]);
  const jobColumns: DataTableColumn<JobOperationsRow>[] = [
    {
      id: "job",
      header: "Job",
      cell: (job) => (
        <div className="table-primary">
          <Link href={`/jobs/${encodeURIComponent(job.id)}`}>{job.job_type}</Link>
          <span>{job.project_name ?? "System job"}</span>
        </div>
      )
    },
    { id: "status", header: "Status", cell: (job) => <StatusBadge status={job.status} /> },
    { id: "attempts", header: "Attempts", align: "right", cell: (job) => `${job.attempts}/${job.max_attempts}` },
    { id: "updated", header: "Updated", cell: (job) => formatDateTime(job.updated_at.toISOString()) }
  ];

  return (
    <PageShell
      actions={<Link className="ui-link-button" href="/runs">Create run</Link>}
      description="Monitor durable execution, workers, providers, documents, and quality signals without exposing secrets."
      title="Operations"
    >
      <div className="page-stack">
        <section className="metric-grid metric-grid--six">
          <KpiCard href="/jobs" icon={<Clock3 />} label="Queue depth" tone={metrics.queue.depth ? "warning" : "success"} value={metrics.queue.depth} detail={metrics.queue.oldestQueuedAgeSeconds === null ? "No queued jobs" : `Oldest ${Math.round(metrics.queue.oldestQueuedAgeSeconds)}s`} />
          <KpiCard href="/jobs?status=RUNNING" icon={<Workflow />} label="Running jobs" tone="info" value={metrics.queue.running} detail={`${metrics.queue.retryWaiting} waiting to retry`} />
          <KpiCard icon={<Server />} label="Workers" tone={metrics.workers.stale ? "danger" : "success"} value={metrics.workers.active} detail={`${metrics.workers.stale} stale`} />
          <KpiCard icon={<Bot />} label="Provider failures" tone={metrics.providers.failures ? "warning" : "success"} value={`${(metrics.providers.failureRate * 100).toFixed(1)}%`} detail={`${metrics.providers.requests} requests`} />
          <KpiCard href="/documents" icon={<FileWarning />} label="Document failures" tone={metrics.documents.extractionFailures ? "danger" : "neutral"} value={metrics.documents.extractionFailures} detail={`${metrics.documents.infectedOrRejected} infected or rejected`} />
          <KpiCard icon={<AlertTriangle />} label="QA blockers" tone={metrics.qa.blockers ? "danger" : "success"} value={metrics.qa.blockers} detail={`Generated ${formatDateTime(metrics.generatedAt)}`} />
        </section>

        <section className="split-grid">
          <article className="section-card">
            <div className="section-heading"><div><h2>Worker readiness</h2><p>Web health is separate from worker heartbeat readiness.</p></div><Link href="/api/workers" className="ui-link-button ui-link-button--secondary">JSON</Link></div>
            {workers.length === 0 ? <EmptyState compact title="No workers registered" description="Start a worker process to claim queued jobs." /> : (
              <ul className="record-list semantic-list">
                {workers.map((worker) => (
                  <li className="record-card" key={String(worker.worker_id)}>
                    <div className="record-card__header"><div><h3>{String(worker.worker_id)}</h3><p>{Number(worker.active_jobs)} active of {Number(worker.concurrency)}</p></div><StatusBadge status={worker.stale ? "STALE" : String(worker.status)} /></div>
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="section-card">
            <div className="section-heading"><div><h2>Research runs</h2><p>Latest durable pipelines across projects.</p></div><Link href="/runs" className="ui-link-button ui-link-button--secondary">View runs</Link></div>
            {runs.length === 0 ? <EmptyState compact title="No research runs" description="Create a run from an approved project plan." /> : (
              <ul className="record-list semantic-list">{runs.map((run) => <li className="record-card" key={run.id}><div className="record-card__header"><div><Link href={`/runs/${encodeURIComponent(run.id)}`}><strong>{run.project_name}</strong></Link><p>{run.current_stage ?? "No current stage"} · {run.progress}%</p></div><StatusBadge status={run.status} /></div></li>)}</ul>
            )}
          </article>
        </section>

        <section className="section-card section-card--flush">
          <div className="section-heading section-heading--padded"><div><h2>Recent jobs</h2><p>Safe operational metadata only; payloads and document contents are omitted.</p></div><Link href="/jobs" className="ui-link-button ui-link-button--secondary">Open queue</Link></div>
          <DataTable caption="Recent durable jobs" columns={jobColumns} emptyState={<EmptyState compact title="No jobs" description="No durable work has been queued." />} getRowKey={(job) => job.id} rows={jobs} />
        </section>
      </div>
    </PageShell>
  );
}
