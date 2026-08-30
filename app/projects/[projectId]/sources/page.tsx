import { ExternalLink } from "lucide-react";
import Link from "next/link";

import { formatDate, humanize, safeExternalUrl } from "@/components/features/format";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";
import { SourceManager } from "@/components/features/source-manager";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SourcesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const bundle = await loadProjectBundle(projectId);
  const evidenceCounts = new Map<string, number>();
  for (const evidence of bundle.evidence) evidenceCounts.set(evidence.source_id, (evidenceCounts.get(evidence.source_id) ?? 0) + 1);
  const columns: DataTableColumn<(typeof bundle.sources)[number]>[] = [
    { id: "source", header: "Source", cell: (source) => <div className="table-primary"><Link href={`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.id)}`}>{source.title}</Link><span>{source.publisher ?? "Publisher unknown"}{source.author ? ` · ${source.author}` : ""}</span></div> },
    { id: "type", header: "Type", cell: (source) => humanize(source.source_type) },
    { id: "published", header: "Published", cell: (source) => formatDate(source.published_at) },
    { id: "quality", header: "Quality", cell: (source) => <div className="badge-stack"><StatusBadge status={source.reliability_grade} tone={source.reliability_grade === "A" ? "success" : source.reliability_grade === "D" ? "danger" : "neutral"}>Grade {source.reliability_grade}</StatusBadge><StatusBadge status={source.freshness_status} /></div> },
    { id: "evidence", header: "Evidence", align: "right", cell: (source) => evidenceCounts.get(source.id) ?? 0 },
    { id: "origin", header: "Origin", cell: (source) => humanize(source.ingestion_method) },
    { id: "url", header: "Original", cell: (source) => { const safeUrl = safeExternalUrl(source.url); return safeUrl ? <a aria-label={`Open original source: ${source.title}`} className="icon-link" href={safeUrl} rel="noreferrer" target="_blank"><ExternalLink aria-hidden="true" /> Open</a> : "Stored content"; } },
  ];
  return (
    <ProjectPageShell description="Acquire, inspect, grade, and extract evidence from source material." project={bundle.project} title="Sources">
      <div className="page-stack">
        <SourceManager projectId={projectId} />
        <section className="section-card section-card--flush">
          <div className="section-heading section-heading--padded"><div><h2>Source library</h2><p>{bundle.sources.length} source{bundle.sources.length === 1 ? "" : "s"} and {bundle.evidence.length} evidence excerpt{bundle.evidence.length === 1 ? "" : "s"} in this project.</p></div></div>
          <DataTable caption="Project sources" columns={columns} emptyState={<EmptyState compact title="No sources acquired" description="Add a source manually or use search, fetch, upload, import, or reuse." />} getRowKey={(source) => source.id} rows={bundle.sources} />
        </section>
      </div>
    </ProjectPageShell>
  );
}
