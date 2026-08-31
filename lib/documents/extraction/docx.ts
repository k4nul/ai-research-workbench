import { Buffer } from "node:buffer";
import * as yauzl from "yauzl";
import { XMLParser } from "fast-xml-parser";
import {
  ExtractionError,
  assertDocumentByteLimit,
  finalizeExtraction,
  mergeExtractionLimits,
  type BlockDraft,
  type DocumentExtractionResult,
  type ExtractionLimits
} from "./types";

const EXTRACTOR_NAME = "bounded-ooxml";
const EXTRACTOR_VERSION = "1";

type XmlNode = Record<string, unknown>;

export interface DocxArchiveEntry {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted?: boolean;
  decodable?: boolean;
}

export function validateDocxArchiveEntry(
  entry: DocxArchiveEntry,
  limits: ExtractionLimits
): void {
  const normalized = entry.fileName.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    !entry.fileName ||
    entry.fileName.includes("\\") ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX contains an unsafe archive path.");
  }
  if (entry.encrypted || entry.decodable === false) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX contains an encrypted or unsupported entry.");
  }
  if (entry.uncompressedSize < 0 || entry.compressedSize < 0) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX entry has an invalid size.");
  }
  if (
    entry.uncompressedSize > 0 &&
    entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio
  ) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX entry exceeds the compression ratio limit.");
  }
  if (entry.uncompressedSize > limits.maxExpandedBytes) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX entry exceeds the expanded byte limit.");
  }
  if (
    /(^|\/)(?:vbaproject\.bin|activex(?:\/|$)|embeddings(?:\/|$))/i.test(normalized)
  ) {
    throw new ExtractionError(
      "UNSUPPORTED_ACTIVE_CONTENT",
      "DOCX contains macro or embedded active content."
    );
  }
}

export function validateDocxXml(value: string, limits: ExtractionLimits): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) {
    throw new ExtractionError("UNSAFE_XML", "DOCX XML declarations are unsafe.");
  }
  const nodeCount = value.match(/<(?!!|\?|\/)[^>]+>/g)?.length ?? 0;
  if (nodeCount > limits.maxXmlNodes) {
    throw new ExtractionError("UNSAFE_XML", "DOCX XML node count exceeds its limit.");
  }
}

export function assertNoExternalRelationships(value: string): void {
  if (/\bTargetMode\s*=\s*["']External["']/i.test(value)) {
    throw new ExtractionError(
      "UNSUPPORTED_ACTIVE_CONTENT",
      "DOCX contains an external relationship."
    );
  }
}

function decodeXml(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ExtractionError("UNSAFE_XML", "DOCX XML encoding is invalid.", { cause: error });
  }
}

async function readEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number
): Promise<Uint8Array> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.byteLength;
    if (total > maxBytes || total > entry.uncompressedSize) {
      stream.destroy();
      throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX entry expanded beyond its declared limit.");
    }
    chunks.push(chunk);
  }
  if (total !== entry.uncompressedSize) {
    throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX entry size does not match its directory.");
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function isXmlPart(name: string): boolean {
  return (
    name === "[Content_Types].xml" ||
    name.endsWith(".rels") ||
    name === "word/document.xml" ||
    name === "word/footnotes.xml" ||
    /^word\/(?:header|footer)\d+\.xml$/i.test(name) ||
    name === "docProps/core.xml"
  );
}

function parseXml(value: string, limits: ExtractionLimits): XmlNode[] {
  validateDocxXml(value, limits);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    preserveOrder: true,
    processEntities: false,
    trimValues: false
  });
  try {
    return parser.parse(value) as XmlNode[];
  } catch (error) {
    throw new ExtractionError("UNSAFE_XML", "DOCX XML could not be parsed.", { cause: error });
  }
}

function tagName(node: XmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ":@" && key !== "#text");
}

function childNodes(node: XmlNode): XmlNode[] {
  const tag = tagName(node);
  const value = tag ? node[tag] : undefined;
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function nodesByTag(nodes: readonly XmlNode[], wanted: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const node of nodes) {
    if (tagName(node) === wanted) result.push(node);
    result.push(...nodesByTag(childNodes(node), wanted));
  }
  return result;
}

function attribute(node: XmlNode, name: string): string | undefined {
  const attrs = node[":@"];
  if (!attrs || typeof attrs !== "object") return undefined;
  const raw = (attrs as Record<string, unknown>)[`@_${name}`];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function visibleText(nodes: readonly XmlNode[]): string {
  let result = "";
  const visit = (items: readonly XmlNode[], insideText: boolean) => {
    for (const node of items) {
      const tag = tagName(node);
      if (tag === "tab") result += "\t";
      else if (tag === "br" || tag === "cr") result += "\n";
      const text = node["#text"];
      if (insideText && typeof text === "string") result += decodeEntities(text);
      visit(childNodes(node), insideText || tag === "t");
    }
  };
  visit(nodes, false);
  return result.replace(/[\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function paragraphDraft(
  node: XmlNode,
  sectionStack: string[],
  paragraphIndex: number
): BlockDraft | undefined {
  const text = visibleText(childNodes(node));
  if (!text) return undefined;
  const styleNode = nodesByTag(childNodes(node), "pStyle")[0];
  const style = styleNode ? attribute(styleNode, "val") : undefined;
  const heading = style?.match(/^Heading\s*([1-6])$/i);
  const kind = heading ? "HEADING" : "PARAGRAPH";
  const sectionPath = sectionStack.length ? sectionStack.join(" > ") : undefined;
  if (heading) {
    const level = Number(heading[1]);
    sectionStack.splice(level - 1);
    sectionStack[level - 1] = text;
  }
  return {
    kind,
    text,
    sectionPath,
    paragraphIndex,
    metadata: {
      style,
      hyperlinkRelationshipIds: nodesByTag(childNodes(node), "hyperlink")
        .map((item) => attribute(item, "id"))
        .filter(Boolean)
    }
  };
}

function tableDraft(node: XmlNode, sectionStack: string[]): BlockDraft | undefined {
  const rows = nodesByTag(childNodes(node), "tr").map((row) =>
    nodesByTag(childNodes(row), "tc")
      .map((cell) => visibleText(childNodes(cell)))
      .join("\t")
  );
  const text = rows.filter(Boolean).join("\n").trim();
  if (!text) return undefined;
  return {
    kind: "TABLE",
    text,
    sectionPath: sectionStack.length ? sectionStack.join(" > ") : undefined,
    metadata: { rowCount: rows.length }
  };
}

function documentDrafts(documentXml: string, limits: ExtractionLimits): {
  drafts: BlockDraft[];
  sectionCount: number;
} {
  const nodes = parseXml(documentXml, limits);
  const body = nodesByTag(nodes, "body")[0];
  if (!body) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "DOCX has no document body.");
  }
  const drafts: BlockDraft[] = [];
  const sectionStack: string[] = [];
  let sectionCount = 1;
  let paragraphIndex = 0;
  for (const node of childNodes(body)) {
    const tag = tagName(node);
    if (tag === "p") {
      const draft = paragraphDraft(node, sectionStack, paragraphIndex++);
      if (draft) drafts.push(draft);
      if (nodesByTag(childNodes(node), "sectPr").length > 0) sectionCount += 1;
    } else if (tag === "tbl") {
      const draft = tableDraft(node, sectionStack);
      if (draft) drafts.push(draft);
    } else if (tag === "sectPr") {
      sectionCount += 1;
    }
  }
  return { drafts, sectionCount };
}

function footnoteDrafts(footnotesXml: string, limits: ExtractionLimits): BlockDraft[] {
  return nodesByTag(parseXml(footnotesXml, limits), "footnote")
    .filter((node) => Number(attribute(node, "id") ?? -1) >= 0)
    .map((node) => ({
      kind: "FOOTNOTE" as const,
      text: visibleText(childNodes(node)),
      sectionPath: "Footnotes",
      metadata: { footnoteId: attribute(node, "id") }
    }))
    .filter((draft) => draft.text.length > 0);
}

function coreProperties(coreXml: string | undefined, limits: ExtractionLimits): Record<string, string> {
  if (!coreXml) return {};
  const nodes = parseXml(coreXml, limits);
  const result: Record<string, string> = {};
  for (const name of ["title", "creator", "subject", "description", "created", "modified"]) {
    const node = nodesByTag(nodes, name)[0];
    const text = node ? visibleText(childNodes(node)) : "";
    if (text) result[name] = text.slice(0, 1_000);
  }
  return result;
}

export async function extractDocxDocument(
  bytes: Uint8Array,
  partialLimits: Partial<ExtractionLimits> = {}
): Promise<DocumentExtractionResult> {
  const limits = mergeExtractionLimits(partialLimits);
  assertDocumentByteLimit(bytes, limits);
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(Buffer.from(bytes), {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    });
  } catch (error) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "DOCX ZIP container is invalid.", {
      cause: error
    });
  }
  const parts = new Map<string, string>();
  let entryCount = 0;
  let expandedBytes = 0;
  let compressedBytes = 0;
  try {
    if (zip.entryCount > limits.maxZipEntries) {
      throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX has too many archive entries.");
    }
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > limits.maxZipEntries) {
        throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX has too many archive entries.");
      }
      validateDocxArchiveEntry(
        {
          fileName: entry.fileName,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          encrypted: entry.isEncrypted(),
          decodable: entry.canDecodeFileData()
        },
        limits
      );
      if (entry.fileName.endsWith("/")) continue;
      expandedBytes += entry.uncompressedSize;
      compressedBytes += entry.compressedSize;
      if (
        expandedBytes > limits.maxExpandedBytes ||
        expandedBytes / Math.max(1, compressedBytes) > limits.maxCompressionRatio
      ) {
        throw new ExtractionError("UNSAFE_ARCHIVE", "DOCX archive expansion exceeds its limit.");
      }
      if (!isXmlPart(entry.fileName)) continue;
      if (entry.uncompressedSize > limits.maxXmlBytes) {
        throw new ExtractionError("UNSAFE_XML", "DOCX XML part exceeds its byte limit.");
      }
      const xml = decodeXml(await readEntry(zip, entry, limits.maxXmlBytes));
      validateDocxXml(xml, limits);
      if (entry.fileName.endsWith(".rels")) assertNoExternalRelationships(xml);
      parts.set(entry.fileName, xml);
    }
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("DOCUMENT_MALFORMED", "DOCX archive could not be read safely.", {
      cause: error
    });
  } finally {
    zip.close();
  }

  const contentTypes = parts.get("[Content_Types].xml");
  const documentXml = parts.get("word/document.xml");
  if (!contentTypes || !documentXml) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "DOCX is missing required OOXML parts.");
  }
  if (/macroEnabled|vbaProject/i.test(contentTypes)) {
    throw new ExtractionError("UNSUPPORTED_ACTIVE_CONTENT", "Macro-enabled documents are blocked.");
  }
  const { drafts, sectionCount } = documentDrafts(documentXml, limits);
  const footnotes = parts.get("word/footnotes.xml");
  if (footnotes) drafts.push(...footnoteDrafts(footnotes, limits));
  if (drafts.length === 0) {
    throw new ExtractionError("DOCUMENT_MALFORMED", "DOCX contains no extractable text.");
  }
  return finalizeExtraction({
    format: "DOCX",
    bytes,
    extractorName: EXTRACTOR_NAME,
    extractorVersion: EXTRACTOR_VERSION,
    drafts,
    limits,
    warnings: [],
    metadata: {
      archiveEntryCount: entryCount,
      expandedBytes,
      compressionRatio: expandedBytes / Math.max(1, compressedBytes),
      sectionCount,
      properties: coreProperties(parts.get("docProps/core.xml"), limits),
      externalRelationshipsAllowed: false,
      macrosAllowed: false
    }
  });
}
