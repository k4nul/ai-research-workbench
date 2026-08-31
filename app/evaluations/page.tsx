import { FlaskConical, ShieldCheck } from "lucide-react";

import { formatDateTime, humanize } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, EmptyState, KpiCard, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { RELEASE_EVAL_THRESHOLDS } from "@/lib/evaluation/metrics";
import { listEvaluationRuns } from "@/lib/services/operations";

export const dynamic = "force-dynamic";

type EvaluationRow = {
  id: string;
  kind: string;
  status: string;
  pipeline_version: string;
  provider: string;
  model: string | null;
  prompt_version: string;
  fixture_count: number;
  summary: Record<string, unknown>;
  estimated_cost: string | number | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
};

function evaluationFailures(summary: Record<string, unknown>): number | null {
  const failures = summary.failures;
  return Array.isArray(failures) ? failures.length : null;
}

export default async function EvaluationsPage() {
  await requirePageOperator();
  const evaluations = (await listEvaluationRuns(100)) as EvaluationRow[];
  const latest = evaluations[0];
  const columns: DataTableColumn<EvaluationRow>[] = [
    { id: "kind", header: "Kind", cell: (row) => humanize(row.kind) },
    { id: "status", header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
    { id: "pipeline", header: "Pipeline", cell: (row) => <div className="table-primary"><strong>{row.pipeline_version}</strong><span>{row.prompt_version}</span></div> },
    { id: "provider", header: "Provider", cell: (row) => <div className="table-primary"><strong>{row.provider}</strong><span>{row.model ?? "Model not recorded"}</span></div> },
    { id: "fixtures", header: "Fixtures", align: "right", cell: (row) => row.fixture_count },
    { id: "failures", header: "Gate failures", align: "right", cell: (row) => evaluationFailures(row.summary) ?? "Not recorded" },
    { id: "completed", header: "Completed", cell: (row) => formatDateTime(row.completed_at?.toISOString()) }
  ];

  return (
    <PageShell
      description="Inspect persisted release-evaluation evidence and the thresholds enforced by the deterministic evaluation suite."
      title="Evaluations"
    >
      <div className="page-stack">
        <section className="metric-grid">
          <KpiCard icon={<FlaskConical />} label="Recorded evaluations" value={evaluations.length} detail="Most recent 100 runs" />
          <KpiCard icon={<ShieldCheck />} label="Latest gate" tone={latest?.status === "PASSED" ? "success" : latest ? "warning" : "neutral"} value={latest ? humanize(latest.status) : "Not run"} detail={latest ? formatDateTime(latest.completed_at?.toISOString() ?? latest.created_at.toISOString()) : "No persisted evidence"} />
          <KpiCard label="Evidence coverage threshold" value={`${Math.round(RELEASE_EVAL_THRESHOLDS.evidenceCoverage * 100)}%`} detail="Minimum release gate" />
          <KpiCard label="Critical claim allowance" value={RELEASE_EVAL_THRESHOLDS.unsupportedCriticalClaimCount} detail="Unsupported critical claims" />
        </section>
        <section className="section-card section-card--flush">
          <div className="section-heading section-heading--padded"><div><h2>Recent evaluation results</h2><p>Artifact references are intentionally omitted from this operator view.</p></div></div>
          <DataTable caption="Recent evaluation results" columns={columns} emptyState={<EmptyState compact title="No evaluations recorded" description="Run the evaluation command to persist release-gate evidence." />} getRowKey={(row) => row.id} rows={evaluations} />
        </section>
      </div>
    </PageShell>
  );
}
