import { createHash } from "node:crypto";
import { assessPromptInjection, type PromptInjectionAssessment } from "@/lib/security/content";
import { sha256Hex } from "@/lib/storage/types";
import type { DocumentExtractionResult, ExtractionBlock } from "./extraction/types";

export const CHUNKER_VERSION = "structure-char-v1";

export interface ChunkingOptions {
  maxChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

export interface DocumentChunk {
  id: string;
  ordinal: number;
  extractionId: string;
  text: string;
  startOffset: number;
  endOffset: number;
  startBlockId: string;
  endBlockId: string;
  pageNumber?: number;
  sectionPath?: string;
  charCount: number;
  contentHash: string;
  chunkerVersion: string;
  securitySignals: PromptInjectionAssessment;
}

export interface CitationAnchor {
  id: string;
  sourceId: string;
  documentId: string;
  extractionId: string;
  chunkId: string;
  pageNumber?: number;
  sectionPath?: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  status: "CURRENT" | "STALE" | "NEEDS_REVIEW";
}

export interface ChunkedDocument {
  chunks: readonly DocumentChunk[];
  anchors: readonly CitationAnchor[];
}

interface ChunkUnit {
  text: string;
  startOffset: number;
  endOffset: number;
  block: ExtractionBlock;
}

function digest(parts: readonly (string | number | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 40);
}

function trimSegment(
  value: string,
  rawStart: number,
  rawEnd: number
): { text: string; start: number; end: number } | undefined {
  const raw = value.slice(rawStart, rawEnd);
  const left = raw.length - raw.trimStart().length;
  const right = raw.length - raw.trimEnd().length;
  const start = rawStart + left;
  const end = rawEnd - right;
  if (end <= start) return undefined;
  return { text: value.slice(start, end), start, end };
}

function splitBlock(block: ExtractionBlock, maxChars: number, overlapChars: number): ChunkUnit[] {
  if (block.text.length <= maxChars) {
    return [
      {
        text: block.text,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        block
      }
    ];
  }
  const units: ChunkUnit[] = [];
  let start = 0;
  while (start < block.text.length) {
    let end = Math.min(block.text.length, start + maxChars);
    if (end < block.text.length) {
      const boundary = block.text.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars / 2)) end = boundary;
    }
    const segment = trimSegment(block.text, start, end);
    if (segment) {
      units.push({
        text: segment.text,
        startOffset: block.startOffset + segment.start,
        endOffset: block.startOffset + segment.end,
        block
      });
    }
    if (end >= block.text.length) break;
    const next = Math.max(start + 1, end - overlapChars);
    start = next;
  }
  return units;
}

function validateOptions(options: ChunkingOptions): Required<ChunkingOptions> {
  const result = {
    maxChars: options.maxChars ?? 4_000,
    overlapChars: options.overlapChars ?? 300,
    maxChunks: options.maxChunks ?? 2_000
  };
  if (!Number.isSafeInteger(result.maxChars) || result.maxChars < 100) {
    throw new Error("maxChars must be an integer of at least 100.");
  }
  if (
    !Number.isSafeInteger(result.overlapChars) ||
    result.overlapChars < 0 ||
    result.overlapChars >= result.maxChars / 2
  ) {
    throw new Error("overlapChars must be non-negative and less than half of maxChars.");
  }
  if (!Number.isSafeInteger(result.maxChunks) || result.maxChunks < 1) {
    throw new Error("maxChunks must be a positive integer.");
  }
  return result;
}

function sameStructure(left: ChunkUnit, right: ChunkUnit): boolean {
  return (
    left.block.pageNumber === right.block.pageNumber &&
    left.block.sectionPath === right.block.sectionPath &&
    right.block.kind !== "HEADING"
  );
}

export function chunkExtraction(input: {
  sourceId: string;
  documentId: string;
  extractionId: string;
  extraction: DocumentExtractionResult;
  options?: ChunkingOptions;
}): ChunkedDocument {
  if (input.extraction.status !== "READY") {
    throw new Error("Only READY extractions can be chunked.");
  }
  const options = validateOptions(input.options ?? {});
  const units = input.extraction.blocks.flatMap((block) =>
    splitBlock(block, options.maxChars, options.overlapChars)
  );
  const grouped: ChunkUnit[][] = [];
  let current: ChunkUnit[] = [];
  let currentChars = 0;
  for (const unit of units) {
    const separatorChars = current.length > 0 ? 2 : 0;
    const fits = currentChars + separatorChars + unit.text.length <= options.maxChars;
    if (
      current.length > 0 &&
      (!fits || !sameStructure(current[current.length - 1], unit))
    ) {
      grouped.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += (current.length > 1 ? 2 : 0) + unit.text.length;
  }
  if (current.length > 0) grouped.push(current);
  if (grouped.length > options.maxChunks) {
    throw new Error("Document exceeds the configured chunk count limit.");
  }

  const chunks: DocumentChunk[] = grouped.map((group, ordinal) => {
    const first = group[0];
    const last = group[group.length - 1];
    const text = group.map((unit) => unit.text).join("\n\n");
    const contentHash = sha256Hex(new TextEncoder().encode(text));
    const id = `chunk-${digest([
      input.extraction.documentHash,
      input.extraction.extractorVersion,
      CHUNKER_VERSION,
      ordinal,
      first.startOffset,
      last.endOffset,
      contentHash
    ])}`;
    return {
      id,
      ordinal,
      extractionId: input.extractionId,
      text,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      startBlockId: first.block.id,
      endBlockId: last.block.id,
      pageNumber: first.block.pageNumber,
      sectionPath: first.block.sectionPath,
      charCount: text.length,
      contentHash,
      chunkerVersion: CHUNKER_VERSION,
      securitySignals: assessPromptInjection(text)
    };
  });
  const anchors: CitationAnchor[] = chunks.map((chunk) => ({
    id: `anchor-${digest([
      input.sourceId,
      input.documentId,
      input.extractionId,
      chunk.id,
      chunk.startOffset,
      chunk.endOffset,
      chunk.contentHash
    ])}`,
    sourceId: input.sourceId,
    documentId: input.documentId,
    extractionId: input.extractionId,
    chunkId: chunk.id,
    pageNumber: chunk.pageNumber,
    sectionPath: chunk.sectionPath,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    contentHash: chunk.contentHash,
    status: "CURRENT"
  }));
  return { chunks, anchors };
}

export function markSupersededAnchors(
  anchors: readonly CitationAnchor[],
  currentExtractionId: string
): readonly CitationAnchor[] {
  return anchors.map((anchor) =>
    anchor.extractionId === currentExtractionId
      ? anchor
      : { ...anchor, status: "NEEDS_REVIEW" as const }
  );
}
