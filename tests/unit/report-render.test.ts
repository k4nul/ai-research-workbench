import { describe, expect, it } from "vitest";

import {
  renderLedgerCsv,
  renderReportHtml,
  renderReportMarkdown,
  renderSourcesCsv,
  type ExportDeliverable,
  type ExportProject
} from "@/lib/export/render";

const project: ExportProject = {
  id: "project-1",
  name: "Sample project",
  core_question: "What changed?",
  purpose: "Test rendering",
  scope: "Fixtures",
  exclusions: null,
  research_date: "2026-08-30",
  jurisdiction: null,
  is_sample: true
};

const deliverable: ExportDeliverable = {
  id: "deliverable-1",
  version: 1,
  title: "Evidence <script>alert(1)</script>",
  sections: {
    researchPurpose: "Explain the result.",
    executiveSummary: "Supported result [source:source-1].",
    researchScope: "Fixture scope.",
    methodology: "Trace claims to evidence.",
    keyFindings: "One finding.",
    detailedAnalysis: "Line one\nLine two <img src=x onerror=alert(1)>",
    comparisonTable: "",
    risksAndLimitations: "Synthetic fixture.",
    recommendations: "Review manually.",
    references: "[source:source-1]",
    appendix: ""
  }
};

describe("report rendering", () => {
  it("renders every report section and identifies sample Markdown", () => {
    const markdown = renderReportMarkdown(project, deliverable);

    expect(markdown).toContain("# Evidence <script>alert(1)</script>");
    expect(markdown).toContain("SAMPLE FIXTURE");
    expect(markdown).toContain("## Executive summary");
    expect(markdown).toContain("## Appendix\n\n_Not provided_");
  });

  it("escapes untrusted report content in standalone HTML", () => {
    const html = renderReportHtml(project, deliverable);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Evidence &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("quotes CSV fields and neutralizes spreadsheet formulas", () => {
    const sources = renderSourcesCsv([
      {
        id: "source-1",
        url: "https://example.test/source",
        title: '=HYPERLINK("https://example.test")',
        publisher: "Example, Inc.",
        author: null,
        published_at: "2026-08-01",
        accessed_at: "2026-08-30",
        source_type: "WEB",
        reliability_grade: "A",
        freshness_status: "CURRENT",
        usage_restrictions: null
      }
    ]);
    const ledger = renderLedgerCsv([
      {
        id: "claim-1",
        content: "+SUM(1,1)",
        claim_type: "FACT",
        importance: "HIGH",
        support_status: "UNSUPPORTED",
        fact_or_inference: "FACT",
        within_scope: true,
        include_in_report: false,
        linked_evidence: []
      }
    ]);

    expect(sources).toContain('"\'=HYPERLINK(""https://example.test"")"');
    expect(sources).toContain('"Example, Inc."');
    expect(ledger).toContain('"\'+SUM(1,1)"');
  });
});
