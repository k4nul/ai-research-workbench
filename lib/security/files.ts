import path from "node:path";

const DEFAULT_MAX_UPLOAD_BYTES = 5_242_880;

const MIME_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".csv": ["text/csv"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ],
  ".htm": ["text/html"],
  ".html": ["text/html"],
  ".json": ["application/json"],
  ".md": ["text/markdown", "text/plain"],
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"]
};

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type FileValidationErrorCode =
  | "INVALID_FILENAME"
  | "UNSUPPORTED_EXTENSION"
  | "MIME_MISMATCH"
  | "INVALID_SIZE"
  | "SIGNATURE_MISMATCH";

export class FileValidationError extends Error {
  constructor(public readonly code: FileValidationErrorCode, message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

export interface UploadedFileInput {
  filename: string;
  mimeType: string;
  size: number;
  bytes?: Uint8Array;
}

export interface ValidatedUpload {
  originalFilename: string;
  safeFilename: string;
  extension: string;
  mimeType: string;
  size: number;
}

export interface FileValidationOptions {
  maxBytes?: number;
}

export function safeFilename(value: string): string {
  if (!value || /[\0\r\n]/.test(value)) {
    throw new FileValidationError("INVALID_FILENAME", "Filename is invalid");
  }
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "";
  let sanitized = leaf
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    sanitized = "upload";
  }
  if (WINDOWS_RESERVED_NAME.test(sanitized)) {
    sanitized = `upload-${sanitized}`;
  }
  if (sanitized.length > 120) {
    const extension = path.extname(sanitized).slice(0, 16);
    const stemLength = Math.max(1, 120 - extension.length);
    sanitized = sanitized.slice(0, stemLength).replace(/[. ]+$/g, "") + extension;
  }
  return sanitized;
}

function normalizedMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function validateSignature(extension: string, bytes: Uint8Array): void {
  if (extension === ".pdf" && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new FileValidationError(
      "SIGNATURE_MISMATCH",
      "PDF content does not have a valid PDF signature"
    );
  }
  if (
    extension === ".docx" &&
    !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
    !startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) &&
    !startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    throw new FileValidationError(
      "SIGNATURE_MISMATCH",
      "DOCX content does not have a valid ZIP container signature"
    );
  }
  if ([".csv", ".htm", ".html", ".json", ".md", ".txt"].includes(extension)) {
    if (bytes.includes(0)) {
      throw new FileValidationError(
        "SIGNATURE_MISMATCH",
        "Text uploads must not contain NUL bytes"
      );
    }
  }
  if (extension === ".json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new FileValidationError(
        "SIGNATURE_MISMATCH",
        `JSON upload is not valid UTF-8 JSON: ${error instanceof Error ? error.message : "invalid data"}`
      );
    }
  }
}

export function validateUploadedFile(
  input: UploadedFileInput,
  options: FileValidationOptions = {}
): ValidatedUpload {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new FileValidationError("INVALID_SIZE", "maxBytes must be a positive integer");
  }
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw new FileValidationError(
      "INVALID_SIZE",
      `Upload size must be between 1 and ${maxBytes} bytes`
    );
  }
  if (input.bytes && input.bytes.byteLength !== input.size) {
    throw new FileValidationError(
      "INVALID_SIZE",
      "Declared upload size does not match the received bytes"
    );
  }

  const filename = safeFilename(input.filename);
  const extension = path.extname(filename).toLowerCase();
  const allowedMimeTypes = MIME_BY_EXTENSION[extension];
  if (!allowedMimeTypes) {
    throw new FileValidationError(
      "UNSUPPORTED_EXTENSION",
      "Upload file extension is not allowed"
    );
  }
  const mimeType = normalizedMimeType(input.mimeType);
  if (!allowedMimeTypes.includes(mimeType)) {
    throw new FileValidationError(
      "MIME_MISMATCH",
      `MIME type ${mimeType || "<missing>"} does not match ${extension}`
    );
  }
  if (!input.bytes) {
    throw new FileValidationError(
      "SIGNATURE_MISMATCH",
      "Upload bytes are required for content validation"
    );
  }
  validateSignature(extension, input.bytes);

  return {
    originalFilename: input.filename,
    safeFilename: filename,
    extension,
    mimeType,
    size: input.size
  };
}
