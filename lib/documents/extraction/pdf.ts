import {
  ExtractionError,
  assertDocumentByteLimit,
  finalizeExtraction,
  mergeExtractionLimits,
  ocrRequiredResult,
  type BlockDraft,
  type DocumentExtractionResult,
  type ExtractionLimits
} from "./types";

const EXTRACTOR_NAME = "pdfjs";
const EXTRACTOR_VERSION = "1";

function boundedPdfInfo(value: object): Record<string, string | number | boolean> {
  const allowed = new Set([
    "Title",
    "Author",
    "Subject",
    "Creator",
    "Producer",
    "CreationDate",
    "ModDate",
    "PDFFormatVersion",
    "IsAcroFormPresent",
    "IsXFAPresent",
    "IsCollectionPresent",
    "IsSignaturesPresent"
  ]);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (typeof raw === "string") result[key] = raw.slice(0, 1_000);
    else if (typeof raw === "number" || typeof raw === "boolean") result[key] = raw;
  }
  return result;
}

export async function extractPdfDocument(
  bytes: Uint8Array,
  partialLimits: Partial<ExtractionLimits> = {}
): Promise<DocumentExtractionResult> {
  const limits = mergeExtractionLimits(partialLimits);
  assertDocumentByteLimit(bytes, limits);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    stopAtErrors: true,
    useWorkerFetch: false,
    useWasm: false,
    useSystemFonts: true
  });
  let passwordRequested = false;
  loadingTask.onPassword = () => {
    passwordRequested = true;
    void loadingTask.destroy();
  };
  try {
    const document = await loadingTask.promise;
    if (document.numPages > limits.maxPages) {
      throw new ExtractionError("EXTRACTION_LIMIT_EXCEEDED", "PDF page count exceeds its limit.");
    }
    const [metadata, attachments, javaScriptActions, openAction] = await Promise.all([
      document.getMetadata(),
      document.getAttachments(),
      document.getJSActions(),
      document.getOpenAction()
    ]);
    const warnings: string[] = [];
    if (attachments && attachments.size > 0) warnings.push("PDF_CONTAINS_ATTACHMENTS");
    if (javaScriptActions && javaScriptActions.size > 0) warnings.push("PDF_CONTAINS_JAVASCRIPT");
    if (openAction && openAction.size > 0) warnings.push("PDF_CONTAINS_OPEN_ACTION");

    const drafts: BlockDraft[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : " ";
      }
      pageText = pageText.replace(/[\t ]+\n/g, "\n").replace(/[\t ]+/g, " ").trim();
      if (pageText) {
        drafts.push({
          kind: "PAGE",
          text: pageText,
          pageNumber,
          sectionPath: `Page ${pageNumber}`,
          metadata: { source: "pdf-text-layer" }
        });
      } else {
        warnings.push(`PDF_EMPTY_OR_TEXTLESS_PAGE:${pageNumber}`);
      }
    }
    const resultMetadata = {
      info: boundedPdfInfo(metadata.info),
      attachmentCount: attachments?.size ?? 0,
      hasJavaScript: (javaScriptActions?.size ?? 0) > 0,
      hasOpenAction: (openAction?.size ?? 0) > 0
    };
    if (drafts.length === 0) {
      return ocrRequiredResult({
        bytes,
        extractorName: EXTRACTOR_NAME,
        extractorVersion: EXTRACTOR_VERSION,
        pageCount: document.numPages,
        warnings,
        metadata: resultMetadata
      });
    }
    return finalizeExtraction({
      format: "PDF",
      bytes,
      extractorName: EXTRACTOR_NAME,
      extractorVersion: EXTRACTOR_VERSION,
      drafts,
      limits,
      pageCount: document.numPages,
      warnings,
      metadata: resultMetadata
    });
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    if (passwordRequested || (error instanceof Error && /password/i.test(error.name))) {
      throw new ExtractionError("DOCUMENT_ENCRYPTED", "Encrypted PDF is not supported.", {
        cause: error
      });
    }
    throw new ExtractionError("DOCUMENT_MALFORMED", "PDF could not be parsed safely.", {
      cause: error
    });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
