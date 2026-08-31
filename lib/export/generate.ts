import { access } from "node:fs/promises";
import { ZipArchive } from "archiver";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import PDFDocument from "pdfkit";
import type { PoolClient } from "pg";
import { withTransaction } from "@/lib/db";
import { conflict, notFound } from "@/lib/services/errors";
import { getDocumentRuntime } from "@/lib/documents/runtime";
import type { ObjectStorage } from "@/lib/storage";
import {
  exportInputHash,
  findReusableExport,
  persistExportArtifact,
  type ExportPersistenceExecution
} from "@/lib/services/export-storage";
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
import {
  exportContentHash,
  loadExportContent
} from "@/lib/export/snapshot";

export type ExportFormat = "MARKDOWN" | "HTML" | "PDF" | "DOCX" | "CSV" | "ZIP";

export type GeneratedArtifact = {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  persisted?: {
    exportId: string;
    inputHash: string;
    sha256: string;
    byteSize: number;
  };
};

export type ExportSnapshot = {
  projectUpdatedAt: string;
  contentHash: string;
  approvalStatus: string;
  qaPassedAt: string | null;
  approvedAt: string | null;
  deliverableId: string;
  deliverableUpdatedAt: string;
};

export type ExportData = {
  project: ExportProject;
  deliverable: ExportDeliverable;
  sources: ExportSource[];
  claims: ExportClaim[];
  qaFindings: Record<string, unknown>[];
  snapshot: ExportSnapshot;
};

export async function loadExportDataInTransaction(
  client: PoolClient,
  projectId: string,
  requireApproval = false
): Promise<ExportData> {
  const lockedProject = await client.query<{
    updated_at: string;
    approval_status: string;
    qa_passed_at: string | null;
    approved_at: string | null;
  }>(
    "SELECT updated_at::text, approval_status, qa_passed_at::text, approved_at::text FROM research_projects WHERE id = $1 FOR UPDATE",
    [projectId]
  );
  if (!lockedProject.rows[0]) {
    throw notFound("Project");
  }
  const content = await loadExportContent(client, projectId);
  const blockers = await client.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM qa_findings WHERE project_id = $1 AND is_current = TRUE AND severity = 'BLOCKER' AND resolution_status <> 'RESOLVED'",
    [projectId]
  );
  if (!content) {
    throw conflict("NO_DELIVERABLE", "Create and save a report before exporting.");
  }
  if (requireApproval) {
    if (lockedProject.rows[0].approval_status !== "APPROVED") {
      throw conflict(
        "APPROVAL_REQUIRED",
        "Explicit human approval is required before final export."
      );
    }
    if (Number(blockers.rows[0].count) > 0) {
      throw conflict("QA_BLOCKED", "Resolve all QA blockers before final export.");
    }
  }
  return {
    ...content,
    snapshot: {
      projectUpdatedAt: lockedProject.rows[0].updated_at,
      contentHash: exportContentHash(content),
      approvalStatus: lockedProject.rows[0].approval_status,
      qaPassedAt: lockedProject.rows[0].qa_passed_at,
      approvedAt: lockedProject.rows[0].approved_at,
      deliverableId: content.deliverable.id,
      deliverableUpdatedAt: (
        await client.query<{ updated_at: string }>(
          "SELECT updated_at::text FROM deliverables WHERE id = $1",
          [content.deliverable.id]
        )
      ).rows[0].updated_at
    }
  };
}

export async function loadExportData(
  projectId: string,
  requireApproval = false
): Promise<ExportData> {
  return withTransaction((client) =>
    loadExportDataInTransaction(client, projectId, requireApproval)
  );
}

export type PdfFontSelection = {
  path: string;
  postscriptName?: string;
};

export async function locatePdfFont(): Promise<PdfFontSelection | undefined> {
  const candidates = [
    process.env.PDF_FONT_PATH
      ? {
          path: process.env.PDF_FONT_PATH,
          postscriptName: process.env.PDF_FONT_NAME || undefined
        }
      : undefined,
    {
      path: "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
      postscriptName: "NotoSansCJKkr-Regular"
    },
    { path: "/usr/share/fonts/noto/NotoSans-Regular.ttf" },
    { path: "/usr/share/fonts/truetype/unifont/unifont.ttf" },
    { path: "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf" },
    { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" }
  ].filter((candidate): candidate is PdfFontSelection => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate.path);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function renderReportPdf(
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
    if (font.postscriptName) {
      document.font(font.path, font.postscriptName);
    } else {
      document.font(font.path);
    }
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

function throwIfExportAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Export generation was cancelled.");
}

async function createDeliveryZip(
  data: ExportData,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfExportAborted(signal);
  const markdown = renderReportMarkdown(data.project, data.deliverable);
  const html = renderReportHtml(data.project, data.deliverable);
  const pdf = await renderReportPdf(data.project, data.deliverable);
  throwIfExportAborted(signal);
  const docx = await createDocx(data.project, data.deliverable);
  throwIfExportAborted(signal);
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
  const archive = await archiveBuffers([
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
  throwIfExportAborted(signal);
  return archive;
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
  options: {
    persist?: boolean;
    requireApproval?: boolean;
    storage?: ObjectStorage;
    storageBucket?: string;
    maxObjectBytes?: number;
    expectedSnapshot?: ExportSnapshot;
    signal?: AbortSignal;
    execution?: ExportPersistenceExecution;
  } = {}
): Promise<GeneratedArtifact> {
  const startedAt = Date.now();
  const requireApproval = options.requireApproval || format === "ZIP";
  throwIfExportAborted(options.signal);
  const data = await loadExportData(projectId, requireApproval);
  throwIfExportAborted(options.signal);
  if (
    options.expectedSnapshot &&
    exportInputHash(projectId, format, options.expectedSnapshot) !==
      exportInputHash(projectId, format, data.snapshot)
  ) {
    throw conflict(
      "EXPORT_STALE",
      "The project changed after the export job was submitted. Submit a new export job."
    );
  }
  const shouldPersist = options.persist ?? format === "ZIP";
  const configured =
    options.storage && options.storageBucket && options.maxObjectBytes
      ? undefined
      : getDocumentRuntime();
  const runtime = {
    storage: options.storage ?? configured!.storage,
    bucket: options.storageBucket ?? configured!.storageBucket,
    maxObjectBytes: options.maxObjectBytes ?? configured!.maxObjectBytes
  };
  const descriptor = artifactName(format);
  if (shouldPersist) {
    const reusable = await findReusableExport({
      projectId,
      format,
      snapshot: data.snapshot,
      runtime,
      execution: options.execution
    });
    if (reusable) {
      throwIfExportAborted(options.signal);
      const { buffer, ...persisted } = reusable;
      return { format, ...descriptor, buffer, persisted };
    }
  }

  throwIfExportAborted(options.signal);
  let buffer: Buffer;
  switch (format) {
    case "MARKDOWN":
      buffer = Buffer.from(renderReportMarkdown(data.project, data.deliverable));
      break;
    case "HTML":
      buffer = Buffer.from(renderReportHtml(data.project, data.deliverable));
      break;
    case "PDF":
      buffer = await renderReportPdf(data.project, data.deliverable);
      break;
    case "DOCX":
      buffer = await createDocx(data.project, data.deliverable);
      break;
    case "CSV":
      buffer = Buffer.from(renderLedgerCsv(data.claims));
      break;
    case "ZIP":
      buffer = await createDeliveryZip(data, options.signal);
      break;
  }
  throwIfExportAborted(options.signal);
  const artifact = { format, ...descriptor, buffer };
  if (shouldPersist) {
    const persisted = await persistExportArtifact({
      projectId,
      snapshot: data.snapshot,
      artifact,
      requireApproval,
      runtime,
      durationMs: Date.now() - startedAt,
      execution: options.execution
    });
    const { buffer: persistedBuffer, ...persistedReference } = persisted;
    return { ...artifact, buffer: persistedBuffer, persisted: persistedReference };
  }
  return artifact;
}

export async function persistArtifact(
  projectId: string,
  snapshot: ExportSnapshot,
  artifact: GeneratedArtifact,
  requireApproval = false
): Promise<void> {
  const configured = getDocumentRuntime();
  await persistExportArtifact({
    projectId,
    snapshot,
    artifact,
    requireApproval,
    runtime: {
      storage: configured.storage,
      bucket: configured.storageBucket,
      maxObjectBytes: configured.maxObjectBytes
    },
    durationMs: 0
  });
}
