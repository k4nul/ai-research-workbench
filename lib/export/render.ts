import type { ReportSections } from "@/lib/validation";

export type ExportProject = {
  id: string;
  name: string;
  core_question: string;
  purpose: string;
  scope: string;
  exclusions: string | null;
  research_date: string;
  jurisdiction: string | null;
  is_sample: boolean;
};

export type ExportDeliverable = {
  id: string;
  version: number;
  title: string;
  sections: ReportSections;
};

export type ExportSource = {
  id: string;
  url: string | null;
  title: string;
  publisher: string | null;
  author: string | null;
  published_at: string | null;
  accessed_at: string;
  source_type: string;
  reliability_grade: string;
  freshness_status: string;
  usage_restrictions: string | null;
};

export type ExportClaim = {
  id: string;
  content: string;
  claim_type: string;
  importance: string;
  support_status: string;
  fact_or_inference: string;
  include_in_report: boolean;
  linked_evidence: Array<{
    evidenceId: string;
    summary: string;
    quote: string | null;
    relationship: string;
    sourceId: string;
    sourceTitle: string;
  }>;
};

const sections: Array<[keyof ReportSections, string]> = [
  ["researchPurpose", "Research purpose"],
  ["executiveSummary", "Executive summary"],
  ["researchScope", "Research scope"],
  ["methodology", "Methodology"],
  ["keyFindings", "Key findings"],
  ["detailedAnalysis", "Detailed analysis"],
  ["comparisonTable", "Comparison table"],
  ["risksAndLimitations", "Risks and limitations"],
  ["recommendations", "Recommendations"],
  ["references", "References"],
  ["appendix", "Appendix"]
];

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderReportMarkdown(
  project: ExportProject,
  deliverable: ExportDeliverable
): string {
  const lines = [
    "# " + deliverable.title,
    "",
    project.is_sample
      ? "> SAMPLE FIXTURE — This report is synthetic demonstration data, not real-world research."
      : "",
    "",
    "Research date: " + project.research_date,
    ""
  ];
  for (const [key, title] of sections) {
    lines.push("## " + title, "", deliverable.sections[key] || "_Not provided_", "");
  }
  return lines.join("\n").trim() + "\n";
}

export function renderReportHtml(
  project: ExportProject,
  deliverable: ExportDeliverable
): string {
  const body = sections
    .map(
      ([key, title]) =>
        "<section><h2>" +
        escapeHtml(title) +
        "</h2><div class=\"section-copy\">" +
        escapeHtml(deliverable.sections[key] || "Not provided") +
        "</div></section>"
    )
    .join("");
  const sampleNotice = project.is_sample
    ? "<aside class=\"sample\">SAMPLE FIXTURE — Synthetic demonstration data, not real-world research.</aside>"
    : "";
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" +
    escapeHtml(deliverable.title) +
    "</title><style>" +
    "body{font-family:Arial,sans-serif;color:#18212f;max-width:900px;margin:48px auto;padding:0 24px;line-height:1.55}" +
    "h1{font-size:2rem;line-height:1.2}h2{margin-top:2rem;border-bottom:1px solid #d9dee8;padding-bottom:.35rem}" +
    ".section-copy{white-space:pre-wrap}.meta{color:#5e6978}.sample{background:#fff4ce;border:1px solid #e3b341;padding:12px 16px;margin:20px 0;font-weight:700}" +
    "@media print{body{margin:0;max-width:none}.sample{break-inside:avoid}}" +
    "</style></head><body><h1>" +
    escapeHtml(deliverable.title) +
    "</h1>" +
    sampleNotice +
    "<p class=\"meta\">Research date: " +
    escapeHtml(project.research_date) +
    "</p>" +
    body +
    "</body></html>"
  );
}

function csvCell(value: unknown): string {
  const normalized =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return '"' + normalized.replaceAll('"', '""') + '"';
}

export function renderSourcesCsv(sources: ExportSource[]): string {
  const rows = [
    [
      "source_id",
      "title",
      "publisher",
      "author",
      "url",
      "published_at",
      "accessed_at",
      "source_type",
      "reliability",
      "freshness",
      "usage_restrictions"
    ],
    ...sources.map((source) => [
      source.id,
      source.title,
      source.publisher,
      source.author,
      source.url,
      source.published_at,
      source.accessed_at,
      source.source_type,
      source.reliability_grade,
      source.freshness_status,
      source.usage_restrictions
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function renderLedgerCsv(claims: ExportClaim[]): string {
  const rows: unknown[][] = [
    [
      "claim_id",
      "claim",
      "claim_type",
      "importance",
      "support_status",
      "fact_or_inference",
      "included",
      "relationship",
      "evidence_id",
      "evidence_summary",
      "minimal_quote",
      "source_id",
      "source_title"
    ]
  ];
  for (const claim of claims) {
    if (!claim.linked_evidence.length) {
      rows.push([
        claim.id,
        claim.content,
        claim.claim_type,
        claim.importance,
        claim.support_status,
        claim.fact_or_inference,
        claim.include_in_report,
        "",
        "",
        "",
        "",
        "",
        ""
      ]);
      continue;
    }
    for (const evidence of claim.linked_evidence) {
      rows.push([
        claim.id,
        claim.content,
        claim.claim_type,
        claim.importance,
        claim.support_status,
        claim.fact_or_inference,
        claim.include_in_report,
        evidence.relationship,
        evidence.evidenceId,
        evidence.summary,
        evidence.quote,
        evidence.sourceId,
        evidence.sourceTitle
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
