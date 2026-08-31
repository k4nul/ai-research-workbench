import { ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";

import { EvidenceForm } from "@/components/features/evidence-form";
import { formatDate, formatDateTime, humanize, safeExternalUrl } from "@/components/features/format";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProject, loadSource } from "@/components/features/server-data";
import { DataTable, DetailPanel, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function SourceDetailPage({ params }: { params: Promise<{ projectId: string; sourceId: string }> }) {
  await requirePageOperator();
  const { projectId, sourceId } = await params;
  const [project, detail] = await Promise.all([loadProject(projectId), loadSource(sourceId)]);
  if (detail.source.project_id !== projectId) notFound();
  const sourceUrl = safeExternalUrl(detail.source.url);
  const evidenceColumns: DataTableColumn<(typeof detail.evidence)[number]>[] = [
    { id: "summary", header: "Evidence", cell: (item) => <div className="table-primary"><strong>{item.summary}</strong>{item.minimal_quote ? <q>{item.minimal_quote}</q> : <span>No direct quote stored.</span>}</div> },
    { id: "location", header: "Location", cell: (item) => item.page_or_section ?? item.original_location ?? "Not recorded" },
    { id: "confidence", header: "Confidence", cell: (item) => <StatusBadge status={item.confidence} /> },
    { id: "verification", header: "Verification", cell: (item) => <StatusBadge status={item.verification_status} /> },
    { id: "created", header: "Created", cell: (item) => formatDateTime(item.created_at) },
  ];
  const aside = <DetailPanel eyebrow="Source metadata" title="Provenance"><dl className="detail-list"><div><dt>Publisher</dt><dd>{detail.source.publisher ?? "Unknown"}</dd></div><div><dt>Author</dt><dd>{detail.source.author ?? "Unknown"}</dd></div><div><dt>Published</dt><dd>{formatDate(detail.source.published_at)}</dd></div><div><dt>Accessed</dt><dd>{formatDateTime(detail.source.accessed_at)}</dd></div><div><dt>Type</dt><dd>{humanize(detail.source.source_type)}</dd></div><div><dt>Language</dt><dd>{detail.source.language}</dd></div><div><dt>Ingestion</dt><dd>{humanize(detail.source.ingestion_method)}</dd></div><div><dt>Restrictions</dt><dd>{detail.source.usage_restrictions ?? "None recorded"}</dd></div></dl>{sourceUrl ? <a className="ui-link-button ui-link-button--secondary full-width" href={sourceUrl} rel="noreferrer" target="_blank">Open original <ExternalLink aria-hidden="true" /></a> : null}</DetailPanel>;
  return (
    <ProjectPageShell aside={aside} description={detail.source.publisher ?? "Publisher unknown"} project={project} title={detail.source.title}>
      <div className="page-stack">
        <section className="section-card"><div className="section-heading"><div><h2>Source assessment</h2><p>Stored content is shown as text and never executed.</p></div><div className="badge-stack badge-stack--horizontal"><StatusBadge status={detail.source.reliability_grade} tone={detail.source.reliability_grade === "A" ? "success" : "neutral"}>Reliability {detail.source.reliability_grade}</StatusBadge><StatusBadge status={detail.source.freshness_status} /></div></div>{detail.source.content_summary ? <p className="lead-copy">{detail.source.content_summary}</p> : <p className="muted-copy">No summary has been stored.</p>}{detail.source.sanitized_content ? <details className="source-content"><summary>View sanitized source content</summary><pre>{detail.source.sanitized_content}</pre></details> : null}</section>
        <EvidenceForm sourceId={sourceId} />
        <section className="section-card section-card--flush"><div className="section-heading section-heading--padded"><div><h2>Evidence excerpts</h2><p>{detail.evidence.length} excerpt{detail.evidence.length === 1 ? "" : "s"} extracted from this source.</p></div></div><DataTable caption={`Evidence from ${detail.source.title}`} columns={evidenceColumns} emptyState={<EmptyState compact title="No evidence extracted" description="Add a summary, minimal quote, and exact location for the material you intend to use." />} getRowKey={(item) => item.id} rows={detail.evidence} /></section>
        {detail.claims.length ? <section className="section-card"><div className="section-heading"><div><h2>Linked claims</h2><p>Claims connected through this source’s evidence.</p></div></div><ul className="record-list semantic-list">{detail.claims.map((claim) => <li className="record-card" key={`${claim.id}-${String((claim as unknown as { evidence_id?: string }).evidence_id ?? "")}`}><div className="record-card__header"><div><p className="record-card__eyebrow">{claim.importance} · {claim.claim_type}</p><h3>{claim.content}</h3></div><StatusBadge status={claim.support_status} /></div></li>)}</ul></section> : null}
      </div>
    </ProjectPageShell>
  );
}
