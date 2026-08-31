import Link from "next/link";

import { formatDateTime, humanize } from "@/components/features/format";
import { LedgerWorkspace } from "@/components/features/ledger-workspace";
import type { ClaimRecord } from "@/components/features/model";
import { asRows } from "@/components/features/model";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";
import { DataTable, EmptyState, StatusBadge, type DataTableColumn } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";
import { listLedger } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

export default async function LedgerPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ unsupported?: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const filters = await searchParams;
  const unsupportedOnly = filters.unsupported === "true";
  const [bundle, ledgerValue] = await Promise.all([loadProjectBundle(projectId), listLedger(projectId, unsupportedOnly)]);
  const claims = asRows<ClaimRecord>(ledgerValue);
  const columns: DataTableColumn<ClaimRecord>[] = [
    { id: "claim", header: "Claim", cell: (claim) => <div className="table-primary"><strong>{claim.content}</strong><span>{claim.fact_or_inference} · {claim.claim_type} · created {formatDateTime(claim.created_at)}</span></div> },
    { id: "importance", header: "Importance", cell: (claim) => <StatusBadge status={claim.importance} /> },
    { id: "support", header: "Support", cell: (claim) => <StatusBadge status={claim.support_status} /> },
    { id: "evidence", header: "Linked evidence and provenance", cell: (claim) => claim.linked_evidence?.length ? <ul className="cell-list">{claim.linked_evidence.map((link) => <li key={`${link.evidenceId}-${link.relationship}`}><div className="cell-badges"><StatusBadge showDot={false} status={link.relationship} tone={link.relationship === "SUPPORTS" ? "success" : link.relationship === "REFUTES" ? "danger" : "info"} /><StatusBadge showDot={false} status={link.supportExtent ?? "FULL"} tone={link.supportExtent === "PARTIAL" ? "warning" : "success"}>Support {link.supportExtent?.toLocaleLowerCase() ?? "full"}</StatusBadge><StatusBadge showDot={false} status={link.reliability ?? "UNRATED"} tone={link.reliability === "A" ? "success" : link.reliability === "D" ? "danger" : "neutral"}>Reliability {link.reliability ?? "unrated"}</StatusBadge><StatusBadge showDot={false} status={link.freshness ?? "UNKNOWN"} tone={link.freshness === "CURRENT" ? "success" : link.freshness === "OUTDATED" || link.freshness === "AGING" ? "warning" : "neutral"} /></div><span><strong>{link.sourceTitle ?? link.sourceId}</strong>{link.publisher ? ` · ${link.publisher}` : ""}<br />{link.summary}</span></li>)}</ul> : <span className="danger-copy">No evidence linked</span> },
    { id: "report", header: "Review status", cell: (claim) => <div className="cell-badges"><StatusBadge showDot={false} status={claim.include_in_report ? "INCLUDED" : "EXCLUDED"} tone={claim.include_in_report ? "info" : "neutral"} /><StatusBadge showDot={false} status={claim.within_scope ? "IN_SCOPE" : "OUT_OF_SCOPE"} tone={claim.within_scope ? "success" : "warning"} /><StatusBadge showDot={false} status={claim.verification_possible ? "VERIFIABLE" : "NOT_VERIFIABLE"} tone={claim.verification_possible ? "neutral" : "warning"} /></div> },
    { id: "issue", header: "Issue / resolution", cell: (claim) => claim.resolution_notes ? <div className="table-primary"><strong>Resolution note</strong><span>{claim.resolution_notes}</span></div> : ["UNSUPPORTED", "CONTESTED", "OUTDATED", "NOT_VERIFIABLE"].includes(claim.support_status) ? <div className="table-primary"><strong className="danger-copy">Unresolved: {humanize(claim.support_status)}</strong><span>Add verified evidence or record how the issue was resolved.</span></div> : <span className="muted-copy">No unresolved issue recorded</span> },
  ];
  return (
    <ProjectPageShell description="Create atomic claims, attach evidence relationships, and expose unsupported or contested statements." project={bundle.project} title="Claims & evidence ledger">
      <div className="page-stack">
        <LedgerWorkspace claims={bundle.claims} evidence={bundle.evidence} projectId={projectId} questions={bundle.questions} />
        <section className="section-card section-card--flush">
          <div className="section-heading section-heading--padded"><div><h2>Claim ledger</h2><p>{claims.length} {unsupportedOnly ? "unsupported " : ""}claim{claims.length === 1 ? "" : "s"} shown.</p></div><Link className="ui-link-button ui-link-button--secondary" href={unsupportedOnly ? `/projects/${projectId}/ledger` : `/projects/${projectId}/ledger?unsupported=true`}>{unsupportedOnly ? "Show all claims" : "Show unsupported only"}</Link></div>
          <DataTable caption="Claim and evidence ledger" columns={columns} emptyState={<EmptyState compact title={unsupportedOnly ? "No unsupported claims" : "No claims yet"} description={unsupportedOnly ? "Every current claim has moved beyond unsupported status." : "Create an atomic claim, then attach project evidence."} />} getRowKey={(claim) => claim.id} rows={claims} />
        </section>
      </div>
    </ProjectPageShell>
  );
}
