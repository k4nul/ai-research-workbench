import { Activity, Bot, Database, Search, ShieldCheck } from "lucide-react";

import { formatDateTime, humanize } from "@/components/features/format";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, KpiCard, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { selectProviders } from "@/lib/providers";
import type { ProviderStatus } from "@/lib/providers/types";
import { getProviderOperationsStatus } from "@/lib/services/operations";

export const dynamic = "force-dynamic";

type ProviderCanaryRow = {
  id: string;
  provider: string;
  model: string | null;
  status: string;
  latency_ms: number | null;
  sanitized_error: string | null;
  created_at: Date;
};

type ProviderExecutionRow = {
  id: string;
  provider: string;
  model: string | null;
  operation: string;
  status: string;
  retry_count: number;
  latency_ms: number | null;
  started_at: Date;
};

export default async function SettingsPage() {
  await requirePageOperator();
  const config = getConfig();
  const selection = selectProviders(config);
  const operations = await getProviderOperationsStatus(10);
  const canaries = operations.canaries as ProviderCanaryRow[];
  const executions = operations.executions as ProviderExecutionRow[];
  const columns: DataTableColumn<ProviderStatus>[] = [
    { id: "kind", header: "Capability", cell: (status) => humanize(status.kind) },
    { id: "provider", header: "Provider", cell: (status) => <div className="table-primary"><strong>{status.provider}</strong>{status.model ? <span>Model: {status.model}</span> : null}</div> },
    { id: "mode", header: "Mode", cell: (status) => <StatusBadge status={status.mode} tone={status.mode === "live" ? "success" : "info"} /> },
    { id: "configuration", header: "Configuration", cell: (status) => <StatusBadge status={status.configured ? "CONFIGURED" : "NOT_CONFIGURED"} tone={status.configured ? "success" : "warning"} /> },
    { id: "active", header: "Active", cell: (status) => status.active ? <StatusBadge status="ACTIVE" /> : "Standby" },
    { id: "credential", header: "Credential", cell: (status) => status.credential },
  ];
  const canaryColumns: DataTableColumn<ProviderCanaryRow>[] = [
    { id: "provider", header: "Provider", cell: (row) => <div className="table-primary"><strong>{row.provider}</strong><span>{row.model ?? "Model not recorded"}</span></div> },
    { id: "status", header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
    { id: "latency", header: "Latency", align: "right", cell: (row) => row.latency_ms === null ? "Not recorded" : `${row.latency_ms.toLocaleString()} ms` },
    { id: "checked", header: "Checked", cell: (row) => formatDateTime(row.created_at.toISOString()) }
  ];
  const executionColumns: DataTableColumn<ProviderExecutionRow>[] = [
    { id: "operation", header: "Operation", cell: (row) => <div className="table-primary"><strong>{humanize(row.operation)}</strong><span>{row.provider}{row.model ? ` · ${row.model}` : ""}</span></div> },
    { id: "status", header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
    { id: "retries", header: "Retries", align: "right", cell: (row) => row.retry_count },
    { id: "latency", header: "Latency", align: "right", cell: (row) => row.latency_ms === null ? "Not recorded" : `${row.latency_ms.toLocaleString()} ms` },
    { id: "started", header: "Started", cell: (row) => formatDateTime(row.started_at.toISOString()) }
  ];
  return (
    <PageShell description="Review runtime mode, provider selection, masked credential state, and local safety limits." title="Settings & provider status">
      <div className="page-stack">
        <section className="metric-grid">
          <KpiCard detail="Controls whether live providers may be selected" icon={<Bot />} label="Runtime mode" tone={config.demoMode ? "info" : "success"} value={config.demoMode ? "Demo" : "Live"} />
          <KpiCard detail={selection.ai.model} icon={<Bot />} label="Active AI" tone="info" value={selection.ai.id} />
          <KpiCard detail="Research discovery" icon={<Search />} label="Active search" tone="info" value={selection.search.id} />
          <KpiCard detail="Uploads are validated before storage" icon={<ShieldCheck />} label="Max upload" value={`${(config.maxUploadBytes / 1_048_576).toFixed(1)} MB`} />
        </section>
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Provider matrix</h2><p>Secrets are masked. Configuration changes are made through environment settings and restart, not this read-only status view.</p></div></div><DataTable caption="Configured provider status" columns={columns} getRowKey={(status) => `${status.kind}-${status.provider}`} rows={selection.statuses} /></section>
        <section className="split-grid">
          <article className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Recent provider canaries</h2><p>Synthetic checks record availability and latency without displaying prompts or credentials.</p></div><Activity aria-hidden="true" /></div><DataTable compact caption="Recent provider canaries" columns={canaryColumns} getRowKey={(row) => row.id} rows={canaries} /></article>
          <article className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Recent provider executions</h2><p>Operational metadata only; request and response content is excluded.</p></div><Activity aria-hidden="true" /></div><DataTable compact caption="Recent provider executions" columns={executionColumns} getRowKey={(row) => row.id} rows={executions} /></article>
        </section>
        <section className="split-grid">
          <article className="section-card"><div className="section-heading"><div><h2>Network and fetch limits</h2><p>Guardrails applied to external source acquisition.</p></div><Database aria-hidden="true" /></div><dl className="detail-list"><div><dt>Fetch timeout</dt><dd>{config.fetchTimeoutMs.toLocaleString()} ms</dd></div><div><dt>Maximum fetched body</dt><dd>{(config.maxFetchBytes / 1_048_576).toFixed(1)} MB</dd></div><div><dt>Application URL</dt><dd>{config.appUrl}</dd></div></dl></article>
          <article className="section-card"><div className="section-heading"><div><h2>Local storage</h2><p>Operational location and research data boundary.</p></div><ShieldCheck aria-hidden="true" /></div><dl className="detail-list"><div><dt>Storage directory</dt><dd><code>{config.storageDir}</code></dd></div><div><dt>Database</dt><dd>PostgreSQL connection configured</dd></div><div><dt>Automatic email</dt><dd>Disabled; delivery is always intentional</dd></div></dl></article>
        </section>
      </div>
    </PageShell>
  );
}
