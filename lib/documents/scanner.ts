import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { sha256Hex } from "@/lib/storage/types";

export type MalwareScanStatus = "CLEAN" | "INFECTED" | "ERROR" | "TIMEOUT" | "UNSCANNED";

export interface MalwareScanInput {
  bytes: Uint8Array;
  signal?: AbortSignal;
}

export interface MalwareScanResult {
  status: MalwareScanStatus;
  scanner: string;
  scannerVersion?: string;
  signatureDatabaseVersion?: string;
  durationMs: number;
  byteSize: number;
  objectSha256: string;
  detectedName?: string;
  sanitizedError?: string;
}

export interface MalwareScanner {
  readonly name: string;
  scan(input: MalwareScanInput): Promise<MalwareScanResult>;
}

export interface ClamAvScannerOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  maxBytes?: number;
  chunkBytes?: number;
}

class ScannerTimeoutError extends Error {}

function cleanScannerText(value: string): string {
  return value
    .replace(/[\0\r\n]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, 500);
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function clamRequest(
  options: Required<Pick<ClamAvScannerOptions, "host" | "port" | "timeoutMs">>,
  command: Uint8Array,
  frames: readonly Uint8Array[],
  terminateFrames: boolean,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Scan cancelled.");
  }
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port });
    const response: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;

    const finish = (error?: unknown, value?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onAbort = () => finish(signal?.reason ?? new Error("Scan cancelled."));

    socket.setTimeout(options.timeoutMs, () =>
      finish(new ScannerTimeoutError("Malware scanner timed out."))
    );
    socket.once("error", finish);
    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > 8_192) {
        finish(new Error("Malware scanner response exceeded its limit."));
        return;
      }
      response.push(chunk);
      const joined = Buffer.concat(response);
      const end = joined.indexOf(0);
      if (end >= 0) {
        finish(undefined, joined.subarray(0, end).toString("utf8"));
      }
    });
    socket.once("end", () => {
      if (!settled) finish(undefined, Buffer.concat(response).toString("utf8"));
    });
    socket.once("connect", () => {
      void (async () => {
        await writeSocket(socket, command);
        for (const frame of frames) {
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(frame.byteLength, 0);
          await writeSocket(socket, length);
          await writeSocket(socket, frame);
        }
        if (terminateFrames) {
          await writeSocket(socket, new Uint8Array(4));
        }
      })().catch(finish);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseVersion(value: string): {
  scannerVersion?: string;
  signatureDatabaseVersion?: string;
} {
  const normalized = cleanScannerText(value);
  const match = normalized.match(/^ClamAV\s+([^/\s]+)(?:\/([^/\s]+))?/i);
  return {
    scannerVersion: match?.[1],
    signatureDatabaseVersion: match?.[2]
  };
}

export class ClamAvScanner implements MalwareScanner {
  readonly name = "clamav";
  private readonly options: Required<ClamAvScannerOptions>;

  constructor(options: ClamAvScannerOptions) {
    if (!options.host.trim() || !Number.isInteger(options.port) || options.port < 1) {
      throw new Error("ClamAV host and port are required.");
    }
    this.options = {
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxBytes: options.maxBytes ?? 25_000_000,
      chunkBytes: options.chunkBytes ?? 64 * 1_024
    };
    if (
      this.options.timeoutMs < 100 ||
      this.options.maxBytes < 1 ||
      this.options.chunkBytes < 1 ||
      this.options.chunkBytes > 1_048_576
    ) {
      throw new Error("ClamAV scanner limits are invalid.");
    }
  }

  async scan(input: MalwareScanInput): Promise<MalwareScanResult> {
    const started = performance.now();
    const base = {
      scanner: this.name,
      byteSize: input.bytes.byteLength,
      objectSha256: sha256Hex(input.bytes)
    };
    if (input.bytes.byteLength > this.options.maxBytes) {
      return {
        ...base,
        status: "ERROR",
        durationMs: Math.round(performance.now() - started),
        sanitizedError: "Object exceeds the malware scanner byte limit."
      };
    }
    try {
      const versionText = await clamRequest(
        this.options,
        Buffer.from("zVERSION\0"),
        [],
        false,
        input.signal
      );
      const version = parseVersion(versionText);
      const frames: Uint8Array[] = [];
      for (let offset = 0; offset < input.bytes.byteLength; offset += this.options.chunkBytes) {
        frames.push(input.bytes.subarray(offset, offset + this.options.chunkBytes));
      }
      const response = cleanScannerText(
        await clamRequest(
          this.options,
          Buffer.from("zINSTREAM\0"),
          frames,
          true,
          input.signal
        )
      );
      const infected = response.match(/^stream:\s+(.+)\s+FOUND$/i);
      if (infected) {
        return {
          ...base,
          ...version,
          status: "INFECTED",
          detectedName: cleanScannerText(infected[1]),
          durationMs: Math.round(performance.now() - started)
        };
      }
      if (/^stream:\s+OK$/i.test(response)) {
        return {
          ...base,
          ...version,
          status: "CLEAN",
          durationMs: Math.round(performance.now() - started)
        };
      }
      return {
        ...base,
        ...version,
        status: "ERROR",
        durationMs: Math.round(performance.now() - started),
        sanitizedError: cleanScannerText(response || "Empty scanner response.")
      };
    } catch (error) {
      return {
        ...base,
        status: error instanceof ScannerTimeoutError ? "TIMEOUT" : "ERROR",
        durationMs: Math.round(performance.now() - started),
        sanitizedError:
          error instanceof ScannerTimeoutError
            ? "Malware scanner timed out."
            : "Malware scanner is unavailable."
      };
    }
  }
}

export interface MockMalwareScannerOptions {
  infectedSha256?: ReadonlySet<string>;
  result?: MalwareScanStatus;
  detectedName?: string;
}

export class MockMalwareScanner implements MalwareScanner {
  readonly name = "mock-malware-scanner";

  constructor(private readonly options: MockMalwareScannerOptions = {}) {}

  async scan(input: MalwareScanInput): Promise<MalwareScanResult> {
    const objectSha256 = sha256Hex(input.bytes);
    const infected = this.options.infectedSha256?.has(objectSha256) === true;
    const status = infected ? "INFECTED" : (this.options.result ?? "CLEAN");
    return {
      status,
      scanner: this.name,
      scannerVersion: "fixture-1",
      signatureDatabaseVersion: "fixture-1",
      durationMs: 0,
      byteSize: input.bytes.byteLength,
      objectSha256,
      detectedName: status === "INFECTED" ? (this.options.detectedName ?? "TEST-SIGNATURE") : undefined,
      sanitizedError:
        status === "ERROR" || status === "TIMEOUT" ? "Synthetic scanner failure." : undefined
    };
  }
}

export interface ScanDispositionOptions {
  production: boolean;
  allowExplicitDemoBypass?: boolean;
}

export interface ScanDisposition {
  documentStatus: "CLEAN" | "REJECTED" | "BLOCKED_SCANNER_UNAVAILABLE";
  bypassed: boolean;
  warning?: string;
}

export function resolveScanDisposition(
  result: MalwareScanResult,
  options: ScanDispositionOptions
): ScanDisposition {
  if (result.status === "CLEAN") {
    return { documentStatus: "CLEAN", bypassed: false };
  }
  if (result.status === "INFECTED") {
    return { documentStatus: "REJECTED", bypassed: false };
  }
  if (!options.production && options.allowExplicitDemoBypass) {
    return {
      documentStatus: "CLEAN",
      bypassed: true,
      warning: "Malware scanning was explicitly bypassed in local demo mode."
    };
  }
  return {
    documentStatus: "BLOCKED_SCANNER_UNAVAILABLE",
    bypassed: false,
    warning: "Malware scanning did not produce a clean result."
  };
}
