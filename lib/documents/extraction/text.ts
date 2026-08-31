import {
  ExtractionError,
  assertDocumentByteLimit,
  finalizeExtraction,
  mergeExtractionLimits,
  type DocumentExtractionResult,
  type ExtractionLimits
} from "./types";

const EXTRACTOR_NAME = "utf8-text";
const EXTRACTOR_VERSION = "1";

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ExtractionError(
      "INVALID_TEXT_ENCODING",
      "Text document is not valid UTF-8.",
      { cause: error }
    );
  }
}

function assertNotBinary(value: string): void {
  if (value.includes("\0")) {
    throw new ExtractionError("BINARY_TEXT", "Text document contains NUL bytes.");
  }
  const controls = [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
  }).length;
  if (value.length > 0 && controls / value.length > 0.01) {
    throw new ExtractionError("BINARY_TEXT", "Text document contains excessive control bytes.");
  }
}

export function extractTextDocument(
  bytes: Uint8Array,
  partialLimits: Partial<ExtractionLimits> = {}
): DocumentExtractionResult {
  const limits = mergeExtractionLimits(partialLimits);
  assertDocumentByteLimit(bytes, limits);
  const decoded = decodeUtf8(bytes);
  assertNotBinary(decoded);
  const normalized = decoded.replace(/\r\n?/g, "\n");
  const paragraphs = normalized
    .split(/\n[\t ]*\n+/)
    .map((text) => text.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "Text document contains no extractable text.");
  }
  return finalizeExtraction({
    format: "TXT",
    bytes,
    extractorName: EXTRACTOR_NAME,
    extractorVersion: EXTRACTOR_VERSION,
    drafts: paragraphs.map((text, paragraphIndex) => ({
      kind: "PARAGRAPH" as const,
      text,
      paragraphIndex
    })),
    limits,
    metadata: {
      encoding: "utf-8",
      bomRemoved: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      lineEndingsNormalized: decoded.includes("\r")
    }
  });
}
