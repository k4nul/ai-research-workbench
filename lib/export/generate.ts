import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import PDFDocument from "pdfkit";
import { query, withTransaction } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { conflict, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";
import { refreshProjectProgress } from "@/lib/services/progress";
import {
  renderLedgerCsv,
  renderReportHtml,
  renderReportMarkdown,
  renderSourcesCsv,
  type ExportClaim,
  type ExportDeliverable,
  type ExportProject,
  type ExportSource
} from "@/lib/export/render";

export type ExportFormat = "MARKDOWN" | "HTML" | "PDF" | "DOCX" | "CSV" | "ZIP";

export type GeneratedArtifact = {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

type ExportData = {
  project: ExportProject;
  deliverable: ExportDeliverable;
  sources: ExportSource[];
  claims: ExportClaim[];
  qaFindings: Record<string, unknown>[];
};

async function loadExportData(projectId: string): Promise<ExportData> {
  const [project, deliverable, sources, claims, qaFindings] = await Promise.all([
    query<ExportProject>("SELECT * FROM research_projects WHERE id = $1", [projectId]),
    query<ExportDeliverable>(
      "SELECT * FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
      [projectId]
    ),
    query<ExportSource>("SELECT * FROM sources WHERE project_id = $1 ORDER BY id", [projectId]),
    query<ExportClaim>(
      "SELECT c.*, COALESCE(json_agg(json_build_object('evidenceId', e.id, 'summary', e.summary, 'quote', e.minimal_quote, 'relationship', ce.relationship, 'sourceId', s.id, 'sourceTitle', s.title)) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS linked_evidence FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id = c.id LEFT JOIN evidence e ON e.id = ce.evidence_id LEFT JOIN sources s ON s.id = e.source_id WHERE c.project_id = $1 GROUP BY c.id ORDER BY c.id",
      [projectId]
    ),
    query<Record<string, unknown>>(
      "SELECT rule_code, severity, location, problem, remediation, resolution_status, created_at, resolved_at FROM qa_findings WHERE project_id = $1 ORDER BY created_at",
      [projectId]
    )
  ]);
  if (!project.rows[0]) {
    throw notFound("Project");
  }
  if (!deliverable.rows[0]) {
    throw conflict("NO_DELIVERABLE", "Create and save a report before exporting.");
  }
  return {
    project: project.rows[0],
    deliverable: deliverable.rows[0],
    sources: sources.rows,
    claims: claims.rows,
    qaFindings: qaFindings.rows
  };
}

async function locatePdfFont(): Promise<string | undefined> {
  const candidates = [
    process.env.PDF_FONT_PATH,
    "/usr/share/fonts/truetype/unifont/unifont.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function createPdf(
  project: ExportProject,
  deliverable: ExportDeliverable
): Promise<Buffer> {
  const document = new PDFDocument({
    size: "A4",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: {
      Title: deliverable.title,
      Subject: "Evidence-first research report"
    }
  });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  const font = await locatePdfFont();
  if (font) {
    document.font(font);
  }
  document.fontSize(22).text(deliverable.title);
  document.moveDown(0.5);
  if (project.is_sample) {
    document
      .fontSize(10)
      .fillColor("#8a4b08")
      .text("SAMPLE FIXTURE — Synthetic demonstration data, not real-world research.");
    document.fillColor("#18212f").moveDown();
  }
  document.fontSize(10).fillColor("#5e6978").text("Research date: " + project.research_date);
  document.fillColor("#18212f");
  const headingMap: Array<[keyof ExportDeliverable["sections"], string]> = [
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
  for (const [key, title] of headingMap) {
    document.moveDown().fontSize(15).text(title);
    document.moveDown(0.3).fontSize(10.5).text(deliverable.sections[key] || "Not provided", {
      lineGap: 3
    });
  }
  document.end();
  return completed;
}

async function createDocx(
  project: ExportProject,
  deliverable: ExportDeliverable
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(deliverable.title)]
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: project.is_sample
            ? "SAMPLE FIXTURE — Synthetic demonstration data, not real-world research."
            : "Evidence-first research report",
          bold: project.is_sample
        })
      ]
    }),
    new Paragraph({ text: "Research date: " + project.research_date })
  ];
  const headingMap: Array<[keyof ExportDeliverable["sections"], string]> = [
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
  for (const [key, title] of headingMap) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: title }));
    for (const line of (deliverable.sections[key] || "Not provided").split("\n")) {
      children.push(new Paragraph({ text: line }));
    }
  }
  const document = new Document({
    creator: "AI Research Workbench",
    title: deliverable.title,
    description: "Evidence-first research report",
    sections: [{ properties: {}, children }]
  });
  return Packer.toBuffer(document);
}

async function archiveBuffers(
  files: Array<{ name: string; data: Buffer | string }>
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.on("warning", reject);
  });
  for (const file of files) {
    archive.append(file.data, { name: file.name });
  }
  await archive.finalize();
  return completed;
}

async function createDeliveryZip(data: ExportData): Promise<Buffer> {
  const markdown = renderReportMarkdown(data.project, data.deliverable);
  const html = renderReportHtml(data.project, data.deliverable);
  const pdf = await createPdf(data.project, data.deliverable);
  const docx = await createDocx(data.project, data.deliverable);
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: data.project,
    deliverable: {
      id: data.deliverable.id,
      version: data.deliverable.version,
      title: data.deliverable.title
    },
    fixture: data.project.is_sample
  };
  const readme = [
    "AI Research Workbench delivery package",
    "",
    "Open final-report.html, final-report.pdf, or final-report.docx for the report.",
    "sources.csv records publication and access dates separately.",
    "claim-evidence-ledger.csv maps every claim to supporting, refuting, or contextual evidence.",
    "qa-findings.json preserves the quality-review record.",
    "project-metadata.json describes the project and identifies sample fixtures.",
    "",
    data.project.is_sample
      ? "IMPORTANT: This package contains synthetic SAMPLE fixtures, not real-world research."
      : "Review the limitations and source-use restrictions before distribution."
  ].join("\n");
  return archiveBuffers([
    { name: "final-report.md", data: markdown },
    { name: "final-report.html", data: html },
    { name: "final-report.pdf", data: pdf },
    { name: "final-report.docx", data: docx },
    { name: "sources.csv", data: renderSourcesCsv(data.sources) },
    { name: "claim-evidence-ledger.csv", data: renderLedgerCsv(data.claims) },
    { name: "qa-findings.json", data: JSON.stringify(data.qaFindings, null, 2) },
    { name: "project-metadata.json", data: JSON.stringify(metadata, null, 2) },
    { name: "README.txt", data: readme }
  ]);
}

function artifactName(format: ExportFormat): { filename: string; mimeType: string } {
  const map: Record<ExportFormat, { filename: string; mimeType: string }> = {
    MARKDOWN: { filename: "final-report.md", mimeType: "text/markdown; charset=utf-8" },
    HTML: { filename: "final-report.html", mimeType: "text/html; charset=utf-8" },
    PDF: { filename: "final-report.pdf", mimeType: "application/pdf" },
    DOCX: {
      filename: "final-report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    },
    CSV: { filename: "claim-evidence-ledger.csv", mimeType: "text/csv; charset=utf-8" },
    ZIP: { filename: "delivery-package.zip", mimeType: "application/zip" }
  };
  return map[format];
}

export async function generateArtifact(
  projectId: string,
  format: ExportFormat,
  options: { persist?: boolean; requireApproval?: boolean } = {}
): Promise<GeneratedArtifact> {
  const data = await loadExportData(projectId);
  if ((options.requireApproval || format === "ZIP") && data.project) {
    const gate = await query<{
      approval_status: string;
      blocker_count: string;
    }>(
      "SELECT p.approval_status, COUNT(q.id) FILTER (WHERE q.severity = 'BLOCKER' AND q.resolution_status <> 'RESOLVED')::text AS blocker_count FROM research_projects p LEFT JOIN qa_findings q ON q.project_id = p.id WHERE p.id = $1 GROUP BY p.id",
      [projectId]
    );
    if (gate.rows[0]?.approval_status !== "APPROVED") {
      throw conflict("APPROVAL_REQUIRED", "Explicit human approval is required before final export.");
    }
    if (Number(gate.rows[0].blocker_count) > 0) {
      throw conflict("QA_BLOCKED", "Resolve all QA blockers before final export.");
    }
  }

  let buffer: Buffer;
  switch (format) {
    case "MARKDOWN":
      buffer = Buffer.from(renderReportMarkdown(data.project, data.deliverable));
      break;
    case "HTML":
      buffer = Buffer.from(renderReportHtml(data.project, data.deliverable));
      break;
    case "PDF":
      buffer = await createPdf(data.project, data.deliverable);
      break;
    case "DOCX":
      buffer = await createDocx(data.project, data.deliverable);
      break;
    case "CSV":
      buffer = Buffer.from(renderLedgerCsv(data.claims));
      break;
    case "ZIP":
      buffer = await createDeliveryZip(data);
      break;
  }
  const descriptor = artifactName(format);
  const artifact = { format, ...descriptor, buffer };
  if (options.persist || format === "ZIP") {
    await persistArtifact(projectId, data.deliverable.id, artifact);
  }
  return artifact;
}

async function persistArtifact(
  projectId: string,
  deliverableId: string,
  artifact: GeneratedArtifact
): Promise<void> {
  const root = path.resolve(getConfig().storageDir, "exports");
  const projectDirectory = path.resolve(root, projectId);
  if (!projectDirectory.startsWith(root + path.sep)) {
    throw new Error("Export path escaped the configured storage root.");
  }
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const versionedName =
    new Date().toISOString().replaceAll(":", "-") + "-" + artifact.filename;
  const outputPath = path.resolve(projectDirectory, versionedName);
  if (!outputPath.startsWith(projectDirectory + path.sep)) {
    throw new Error("Artifact path escaped the project export directory.");
  }
  await writeFile(outputPath, artifact.buffer, { mode: 0o600 });
  const sha256 = createHash("sha256").update(artifact.buffer).digest("hex");
  await withTransaction(async (client) => {
    await client.query(
      "INSERT INTO project_exports (id, project_id, deliverable_id, format, storage_path, sha256, byte_size) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        randomUUID(),
        projectId,
        deliverableId,
        artifact.format,
        outputPath,
        sha256,
        artifact.buffer.byteLength
      ]
    );
    await writeAuditEvent(client, {
      projectId,
      actorType: "SYSTEM",
      actorLabel: "Export service",
      action: "EXPORT_GENERATED",
      resourceType: "project_export",
      afterState: {
        format: artifact.format,
        filename: versionedName,
        sha256,
        byteSize: artifact.buffer.byteLength
      }
    });
    await refreshProjectProgress(client, projectId);
  });
}
