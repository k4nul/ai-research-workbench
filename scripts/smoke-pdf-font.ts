import { createRequire } from "node:module";

import { extractPdfDocument } from "@/lib/documents/extraction/pdf";
import { locatePdfFont, renderReportPdf } from "@/lib/export/generate";
import type { ExportDeliverable, ExportProject } from "@/lib/export/render";

const marker = "PDF 한글 글꼴 검증";

type Fontkit = {
  openSync: (
    path: string,
    postscriptName?: string
  ) => { hasGlyphForCodePoint: (codePoint: number) => boolean };
};

const selectedFont = await locatePdfFont();
if (!selectedFont) {
  throw new Error("No production PDF font was found.");
}
const fontkit = createRequire(import.meta.url)("fontkit") as Fontkit;
const openedFont = fontkit.openSync(selectedFont.path, selectedFont.postscriptName);
for (const character of marker) {
  const codePoint = character.codePointAt(0);
  if (codePoint !== undefined && character.trim() && !openedFont.hasGlyphForCodePoint(codePoint)) {
    throw new Error(
      `Production PDF font ${selectedFont.path} does not cover U+${codePoint
        .toString(16)
        .toUpperCase()}.`
    );
  }
}

const project: ExportProject = {
  id: "synthetic-pdf-font-smoke",
  name: "Synthetic PDF font smoke",
  core_question: "Can the production renderer preserve non-Latin text?",
  purpose: "Container-only renderer verification",
  scope: "Synthetic fixture",
  exclusions: null,
  research_date: "2026-08-31",
  jurisdiction: null,
  is_sample: true
};

const deliverable: ExportDeliverable = {
  id: "synthetic-pdf-font-smoke",
  version: 1,
  title: marker,
  sections: {
    researchPurpose: marker,
    executiveSummary: "Synthetic non-Latin PDF text-layer verification.",
    researchScope: "",
    methodology: "",
    keyFindings: "",
    detailedAnalysis: "",
    comparisonTable: "",
    risksAndLimitations: "",
    recommendations: "",
    references: "",
    appendix: ""
  }
};

const pdf = await renderReportPdf(project, deliverable);
const extracted = await extractPdfDocument(new Uint8Array(pdf));

if (extracted.status !== "READY" || !extracted.text.includes(marker)) {
  throw new Error("Production PDF rendering did not preserve the Hangul smoke marker.");
}

process.stdout.write(`Verified Hangul PDF font coverage and text round-trip: ${marker}\n`);
