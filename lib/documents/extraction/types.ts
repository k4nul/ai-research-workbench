import { createHash } from "node:crypto";
import { assessPromptInjection, type PromptInjectionAssessment } from "@/lib/security/content";
import { sha256Hex } from "@/lib/storage/types";

export type ExtractableDocumentFormat = "PDF" | "DOCX" | "TXT" | "HTML";
export type ExtractionBlockKind = "HEADING" | "PARAGRAPH" | "TABLE" | "FOOTNOTE" | "PAGE";
export type ExtractionConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface ExtractionLimits {
  maxBytes: number;
  maxPages: number;
  maxBlocks: number;
  maxTextChars: number;
  maxZipEntries: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxXmlBytes: number;
  maxXmlNodes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: Readonly<ExtractionLimits> = {
  maxBytes: 25_000_000,
  maxPages: 500,
  maxBlocks: 20_000,
  maxTextChars: 2_000_000,
  maxZipEntries: 2_500,
  maxExpandedBytes: 100_000_000,
  maxCompressionRatio: 100,
  maxXmlBytes: 20_000_000,
  maxXmlNodes: 500_000
};

export type ExtractionErrorCode =
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_MALFORMED"
  | "DOCUMENT_ENCRYPTED"
  | "UNSUPPORTED_ACTIVE_CONTENT"
  | "UNSAFE_ARCHIVE"
  | "UNSAFE_XML"
  | "INVALID_TEXT_ENCODING"
  | "BINARY_TEXT"
  | "EXTRACTION_LIMIT_EXCEEDED";

export class ExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

export interface ExtractionBlock {
  id: string;
  ordinal: number;
  kind: ExtractionBlockKind;
  pageNumber?: number;
  sectionPath?: string;
  paragraphIndex?: number;
  text: string;
  startOffset: number;
  endOffset: number;
  stableAnchor: string;
  language?: string;
  contentHash: string;
  confidence: ExtractionConfidence;
  metadata: Readonly<Record<string, unknown>>;
}

export interface DocumentExtractionResult {
  format: ExtractableDocumentFormat;
  status: "READY" | "OCR_REQUIRED_UNSUPPORTED";
  extractorName: string;
  extractorVersion: string;
  documentHash: string;
  contentHash?: string;
  text: string;
  blocks: readonly ExtractionBlock[];
  pageCount?: number;
  language?: string;
  confidence: ExtractionConfidence;
  warnings: readonly string[];
  securitySignals: PromptInjectionAssessment;
  metadata: Readonly<Record<string, unknown>>;
}

export interface BlockDraft {
  kind: ExtractionBlockKind;
  text: string;
  pageNumber?: number;
  sectionPath?: string;
  paragraphIndex?: number;
  language?: string;
  confidence?: ExtractionConfidence;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface FinalizeExtractionInput {
  format: ExtractableDocumentFormat;
  bytes: Uint8Array;
  extractorName: string;
  extractorVersion: string;
  drafts: readonly BlockDraft[];
  limits: ExtractionLimits;
  pageCount?: number;
  language?: string;
  confidence?: ExtractionConfidence;
  warnings?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export function mergeExtractionLimits(
  limits: Partial<ExtractionLimits> = {}
): ExtractionLimits {
  const merged = { ...DEFAULT_EXTRACTION_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ExtractionError(
        "EXTRACTION_LIMIT_EXCEEDED",
        `${name} must be a positive integer.`
      );
    }
  }
  return merged;
}

export function assertDocumentByteLimit(bytes: Uint8Array, limits: ExtractionLimits): void {
  if (bytes.byteLength === 0) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "Document is empty.");
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new ExtractionError("DOCUMENT_TOO_LARGE", "Document exceeds its extraction byte limit.");
  }
}

function stableId(parts: readonly (string | number | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 40);
}

export function finalizeExtraction(input: FinalizeExtractionInput): DocumentExtractionResult {
  assertDocumentByteLimit(input.bytes, input.limits);
  if (input.drafts.length > input.limits.maxBlocks) {
    throw new ExtractionError("EXTRACTION_LIMIT_EXCEEDED", "Document has too many text blocks.");
  }
  const documentHash = sha256Hex(input.bytes);
  const blocks: ExtractionBlock[] = [];
  let offset = 0;
  for (const draft of input.drafts) {
    const text = draft.text.replace(/[\t ]+\n/g, "\n").trim();
    if (!text) continue;
    if (blocks.length > 0) offset += 2;
    const startOffset = offset;
    const endOffset = startOffset + text.length;
    if (endOffset > input.limits.maxTextChars) {
      throw new ExtractionError("EXTRACTION_LIMIT_EXCEEDED", "Extracted text is too large.");
    }
    const contentHash = sha256Hex(new TextEncoder().encode(text));
    const ordinal = blocks.length;
    const stableAnchor = stableId([
      documentHash,
      input.extractorVersion,
      ordinal,
      draft.pageNumber,
      draft.sectionPath,
      contentHash
    ]);
    blocks.push({
      id: `block-${stableAnchor}`,
      ordinal,
      kind: draft.kind,
      pageNumber: draft.pageNumber,
      sectionPath: draft.sectionPath,
      paragraphIndex: draft.paragraphIndex,
      text,
      startOffset,
      endOffset,
      stableAnchor,
      language: draft.language ?? input.language,
      contentHash,
      confidence: draft.confidence ?? input.confidence ?? "HIGH",
      metadata: draft.metadata ?? {}
    });
    offset = endOffset;
  }
  const text = blocks.map((block) => block.text).join("\n\n");
  return {
    format: input.format,
    status: "READY",
    extractorName: input.extractorName,
    extractorVersion: input.extractorVersion,
    documentHash,
    contentHash: sha256Hex(new TextEncoder().encode(text)),
    text,
    blocks,
    pageCount: input.pageCount,
    language: input.language,
    confidence: input.confidence ?? "HIGH",
    warnings: input.warnings ?? [],
    securitySignals: assessPromptInjection(text),
    metadata: input.metadata ?? {}
  };
}

export function ocrRequiredResult(input: {
  bytes: Uint8Array;
  extractorName: string;
  extractorVersion: string;
  pageCount: number;
  warnings?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}): DocumentExtractionResult {
  return {
    format: "PDF",
    status: "OCR_REQUIRED_UNSUPPORTED",
    extractorName: input.extractorName,
    extractorVersion: input.extractorVersion,
    documentHash: sha256Hex(input.bytes),
    text: "",
    blocks: [],
    pageCount: input.pageCount,
    confidence: "UNKNOWN",
    warnings: ["OCR_REQUIRED_UNSUPPORTED", ...(input.warnings ?? [])],
    securitySignals: assessPromptInjection(""),
    metadata: input.metadata ?? {}
  };
}
