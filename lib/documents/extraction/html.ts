import sanitizeHtml from "sanitize-html";
import { sanitizeExternalHtml } from "@/lib/security/content";
import {
  ExtractionError,
  assertDocumentByteLimit,
  finalizeExtraction,
  mergeExtractionLimits,
  type BlockDraft,
  type DocumentExtractionResult,
  type ExtractionBlockKind,
  type ExtractionLimits
} from "./types";

const EXTRACTOR_NAME = "sanitized-html-structure";
const EXTRACTOR_VERSION = "1";

function textValue(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
}

function structuredBlocks(sanitized: string): BlockDraft[] {
  const drafts: BlockDraft[] = [];
  const sectionStack: string[] = [];
  let buffer = "";
  let kind: ExtractionBlockKind = "PARAGRAPH";
  let headingLevel: number | undefined;

  const flush = () => {
    const text = buffer.replace(/[\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    buffer = "";
    if (!text) return;
    const sectionPath = sectionStack.length ? sectionStack.join(" > ") : undefined;
    drafts.push({ kind, text, sectionPath, paragraphIndex: drafts.length });
    if (kind === "HEADING" && headingLevel) {
      sectionStack.splice(headingLevel - 1);
      sectionStack[headingLevel - 1] = text;
    }
    kind = "PARAGRAPH";
    headingLevel = undefined;
  };

  for (const token of sanitized.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) {
      buffer += textValue(token);
      continue;
    }
    const closing = token.match(/^<\/\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
    const opening = token.match(/^<\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
    const tag = closing ?? opening;
    if (!tag) continue;
    if (/^h[1-6]$/.test(tag)) {
      if (opening && !closing) {
        flush();
        kind = "HEADING";
        headingLevel = Number(tag[1]);
      } else {
        flush();
      }
      continue;
    }
    if (["p", "li", "blockquote", "pre", "div", "tr"].includes(tag)) {
      if (closing) flush();
      else if (buffer.trim()) flush();
      if (tag === "tr") kind = "TABLE";
      continue;
    }
    if (["td", "th"].includes(tag) && closing) {
      buffer += "\t";
      kind = "TABLE";
      continue;
    }
    if (tag === "br") buffer += "\n";
  }
  flush();
  return drafts;
}

export function extractHtmlDocument(
  bytes: Uint8Array,
  partialLimits: Partial<ExtractionLimits> = {}
): DocumentExtractionResult {
  const limits = mergeExtractionLimits(partialLimits);
  assertDocumentByteLimit(bytes, limits);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ExtractionError("INVALID_TEXT_ENCODING", "HTML document is not valid UTF-8.", {
      cause: error
    });
  }
  if (raw.includes("\0")) {
    throw new ExtractionError("BINARY_TEXT", "HTML document contains NUL bytes.");
  }
  const sanitized = sanitizeExternalHtml(raw);
  const drafts = structuredBlocks(sanitized);
  if (drafts.length === 0) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "HTML document contains no extractable text.");
  }
  return finalizeExtraction({
    format: "HTML",
    bytes,
    extractorName: EXTRACTOR_NAME,
    extractorVersion: EXTRACTOR_VERSION,
    drafts,
    limits,
    warnings: raw !== sanitized ? ["ACTIVE_OR_UNSUPPORTED_HTML_REMOVED"] : [],
    metadata: {
      externalResourcesFetched: false,
      sanitizer: "sanitize-html"
    }
  });
}
