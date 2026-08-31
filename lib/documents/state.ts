export const DOCUMENT_STATUSES = [
  "UPLOADING",
  "QUARANTINED",
  "SCANNING",
  "REJECTED",
  "CLEAN",
  "EXTRACTING",
  "READY",
  "EXTRACTION_FAILED",
  "OCR_REQUIRED_UNSUPPORTED",
  "BLOCKED_SCANNER_UNAVAILABLE",
  "DELETED"
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const transitions: Readonly<Record<DocumentStatus, ReadonlySet<DocumentStatus>>> = {
  UPLOADING: new Set(["QUARANTINED", "REJECTED", "DELETED"]),
  QUARANTINED: new Set(["SCANNING", "BLOCKED_SCANNER_UNAVAILABLE", "DELETED"]),
  SCANNING: new Set(["CLEAN", "REJECTED", "BLOCKED_SCANNER_UNAVAILABLE", "DELETED"]),
  REJECTED: new Set(["DELETED"]),
  CLEAN: new Set(["EXTRACTING", "DELETED"]),
  EXTRACTING: new Set([
    "READY",
    "EXTRACTION_FAILED",
    "OCR_REQUIRED_UNSUPPORTED",
    "DELETED"
  ]),
  READY: new Set(["EXTRACTING", "DELETED"]),
  EXTRACTION_FAILED: new Set(["EXTRACTING", "DELETED"]),
  OCR_REQUIRED_UNSUPPORTED: new Set(["EXTRACTING", "DELETED"]),
  BLOCKED_SCANNER_UNAVAILABLE: new Set(["SCANNING", "DELETED"]),
  DELETED: new Set()
};

export class DocumentStateError extends Error {
  constructor(
    public readonly from: DocumentStatus,
    public readonly to: DocumentStatus
  ) {
    super(`Document transition ${from} -> ${to} is not allowed.`);
    this.name = "DocumentStateError";
  }
}

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return transitions[from].has(to);
}

export function assertDocumentTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!canTransitionDocument(from, to)) {
    throw new DocumentStateError(from, to);
  }
}
