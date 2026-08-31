import Link from "next/link";

import { compactId, formatDateTime, humanize } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { OperationAction } from "@/components/operations/operation-action";
import { DataTable, EmptyState, ProgressBar, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import {
  getResearchRunOperationsDetail,
  type JobOperationsRow,
  type RunStageOperationsRow
} from "@/lib/services/operations";

export const dynamic = "force-dynamic";

function usageText(usage: Record<string, unknown>): string {
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  return input || output ? `${input.toLocaleString()} in / ${output.toLocaleString()} out` : "Not recorded";
}

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  await requirePageOperator();
  const { runId } = await params;
  const detail = await getResearchRunOperationsDetail(runId);
  const run = detail.run;
  const stageColumns: DataTableColumn<RunStageOperationsRow>[] = [
    { id: "stage", header: "Stage", cell: (stage) => <div className="table-primary"><strong>{stage.ordinal}. {humanize(stage.stage_id)}</strong><span>Generation {stage.generation}</span></div> },
    { id: "status", header: "Status", cell: (stage) => <StatusBadge status={stage.status} /> },
    { id: "provider", header: "Provider", cell: (stage) => stage.provider ? `${stage.provider}${stage.model ? ` · ${stage.model}` : ""}` : "Not selected" },
    { id: "usage", header: "Tokens", cell: (stage) => usageText(stage.usage) },
    { id: "duration", header: "Duration", align: "right", cell: (stage) => stage.duration_ms === null ? "—" : `${stage.duration_ms.toLocaleString()} ms` },
    {
      id: "action",
      header: "Action",
      cell: (stage) => ["SUCCEEDED", "FAILED", "BLOCKED", "STALE", "CANCELLED"].includes(stage.status)
        ? <OperationAction confirmationMessage="Rerun this stage? This creates a new generation and marks every downstream stage result stale." dangerous endpoint={`/api/runs/${encodeURIComponent(run.id)}/stages/${encodeURIComponent(stage.id)}/rerun`} label="Rerun stage" projectId={run.project_id} successMessage="A new stage generation was queued." />
        : "Not rerunnable"
    }
  ];
  const jobColumns: DataTableColumn<JobOperationsRow>[] = [
    { id: "job", header: "Job", cell: (job) => <Link href={`/jobs/${encodeURIComponent(job.id)}`}>{job.job_type}</Link> },
    { id: "stage", header: "Stage", cell: (job) => job.stage ? humanize(job.stage) : "—" },
    { id: "status", header: "Status", cell: (job) => <StatusBadge status={job.status} /> },
    { id: "attempt", header: "Attempts", align: "right", cell: (job) => `${job.attempts}/${job.max_attempts}` }
  ];
  const canResume = ["CANCELLED", "FAILED", "PAUSED", "BLOCKED"].includes(run.status);
  const canCancel = ["QUEUED", "RUNNING"].includes(run.status);

  return (
    <PageShell actions={<Link className="ui-link-button ui-link-button--secondary" href="/runs">Back to runs</Link>} description={`${run.project_name} · pipeline ${run.pipeline_version}`} eyebrow="Research execution" title={`Run ${compactId(run.id)}`}>
      <div className="page-stack">
        <section className="section-card">
          <div className="section-heading"><div><h2>Run state</h2><p>Approved revision IDs and hashes preserve provenance without exposing source contents.</p></div><StatusBadge status={run.status} /></div>
          <ProgressBar label="Pipeline progress" value={run.progress} tone={run.progress === 100 ? "success" : "default"} />
          <dl className="definition-grid">
            <div><dt>Project</dt><dd><Link href={`/projects/${encodeURIComponent(run.project_id)}`}>{run.project_name}</Link></dd></div>
            <div><dt>Current stage</dt><dd>{run.current_stage ? humanize(run.current_stage) : "Not started"}</dd></div>
            <div><dt>Mode</dt><dd>{humanize(run.mode)}</dd></div>
            <div><dt>Provider requests</dt><dd>{run.total_provider_requests}</dd></div>
            <div><dt>Tokens</dt><dd>{Number(run.total_input_tokens).toLocaleString()} in / {Number(run.total_output_tokens).toLocaleString()} out</dd></div>
            <div><dt>Estimated cost</dt><dd>{run.cost_status === "UNKNOWN" ? "Unknown" : `$${Number(run.estimated_cost ?? 0).toFixed(4)}`}</dd></div>
            <div><dt>Scope revision</dt><dd><code>{compactId(run.scope_revision_id)}</code></dd></div>
            <div><dt>Plan revision</dt><dd><code>{compactId(run.plan_revision_id)}</code></dd></div>
            <div><dt>Updated</dt><dd>{formatDateTime(run.updated_at.toISOString())}</dd></div>
          </dl>
          {run.failure_reason || run.block_reason ? <div className="notice notice--danger"><p>{run.failure_reason ?? run.block_reason}</p></div> : null}
          {canResume || canCancel ? <div className="form-actions">{canResume ? <OperationAction endpoint={`/api/runs/${encodeURIComponent(run.id)}/resume`} label="Resume run" projectId={run.project_id} successMessage="Run returned to the queue." /> : null}{canCancel ? <OperationAction dangerous endpoint={`/api/runs/${encodeURIComponent(run.id)}/cancel`} label="Cancel run" projectId={run.project_id} successMessage="Run cancellation recorded." /> : null}</div> : null}
        </section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Pipeline stages</h2><p>Generations, provider provenance, cost, duration, and stale state.</p></div></div><DataTable caption="Research run stages" columns={stageColumns} emptyState={<EmptyState compact title="No stages" description="This run has no persisted pipeline stages." />} getRowKey={(stage) => stage.id} rows={detail.stages} /></section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Run jobs</h2><p>Durable queue records tied to this pipeline.</p></div></div><DataTable caption="Research run jobs" columns={jobColumns} emptyState={<EmptyState compact title="No jobs" description="No durable jobs are linked to this run." />} getRowKey={(job) => job.id} rows={detail.jobs} /></section>
      </div>
    </PageShell>
  );
}
