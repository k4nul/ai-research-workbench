import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request } from "undici";
import {
  assessPromptInjection,
  externalHtmlToText,
  sanitizeExternalHtml,
  type PromptInjectionAssessment
} from "./content";

const DEFAULT_ALLOWED_MIME_TYPES = [
  "application/json",
  "application/pdf",
  "application/xhtml+xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain"
] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = "ai-research-workbench/0.1 research-source-fetcher";

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "DISALLOWED_ADDRESS"
  | "DNS_FAILURE"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_LOOP"
  | "INVALID_REDIRECT"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_MIME_TYPE"
  | "HTTP_ERROR"
  | "FETCH_FAILED";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface PinnedRequest {
  url: URL;
  hostname: string;
  addresses: readonly ResolvedAddress[];
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  allowedMimeTypes: readonly string[];
}

export interface PinnedResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export type PinnedRequester = (request: PinnedRequest) => Promise<PinnedResponse>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedMimeTypes?: readonly string[];
  userAgent?: string;
  resolver?: DnsResolver;
  requester?: PinnedRequester;
  now?: () => Date;
}

export interface FetchHopMetadata {
  url: string;
  resolvedAddresses: readonly string[];
  status: number;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  text?: string;
  sanitized: boolean;
  promptInjection?: PromptInjectionAssessment;
  fetchedAt: string;
  userAgent: string;
  redirectCount: number;
  hops: readonly FetchHopMetadata[];
  source: {
    hostname: string;
    protocol: "http:" | "https:";
  };
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0;
}

function ipv4InCidr(address: number, network: number, prefix: number): boolean {
  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const blocked: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ];
  return !blocked.some(([network, prefix]) =>
    ipv4InCidr(value, ipv4ToNumber(network), prefix)
  );
}

function ipv6ToBigInt(address: string): bigint {
  if (address.includes("%")) {
    throw new SafeFetchError(
      "DISALLOWED_ADDRESS",
      "IPv6 zone identifiers are not allowed"
    );
  }

  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = ipv4Match[1];
    if (isIP(ipv4) !== 4) {
      throw new SafeFetchError("INVALID_URL", "Invalid IPv4-mapped address");
    }
    const value = ipv4ToNumber(ipv4);
    normalized = normalized.slice(0, -ipv4.length) +
      `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    throw new SafeFetchError("INVALID_URL", "Invalid IPv6 address");
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new SafeFetchError("INVALID_URL", "Invalid IPv6 address");
  }
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    throw new SafeFetchError("INVALID_URL", "Invalid IPv6 address");
  }
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(address: bigint, network: bigint, prefix: number): boolean {
  if (prefix === 0) {
    return true;
  }
  const shift = 128n - BigInt(prefix);
  return address >> shift === network >> shift;
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  const blocked: ReadonlyArray<readonly [string, number]> = [
    ["::", 96],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ];
  return !blocked.some(([network, prefix]) =>
    ipv6InCidr(value, ipv6ToBigInt(network), prefix)
  );
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPublicIpv4(address);
  }
  if (family === 6) {
    return isPublicIpv6(address);
  }
  return false;
}

export function validateExternalUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch (error) {
    throw new SafeFetchError("INVALID_URL", "URL is not valid", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("INVALID_URL", "Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("INVALID_URL", "URLs containing credentials are not allowed");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new SafeFetchError("INVALID_URL", "URL hostname is required");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost.localdomain")
  ) {
    throw new SafeFetchError("DISALLOWED_ADDRESS", "Localhost URLs are not allowed");
  }
  const family = isIP(hostname);
  if (family !== 0 && !isPublicIpAddress(hostname)) {
    throw new SafeFetchError(
      "DISALLOWED_ADDRESS",
      "Private, local, and reserved IP addresses are not allowed"
    );
  }
  url.hash = "";
  return url;
}

export const systemDnsResolver: DnsResolver = async (hostname) => {
  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.map((record) => ({
      address: record.address,
      family: record.family as 4 | 6
    }));
  } catch (error) {
    throw new SafeFetchError("DNS_FAILURE", "DNS resolution failed", { cause: error });
  }
};

export async function resolveAndValidateExternalUrl(
  value: string | URL,
  resolver: DnsResolver = systemDnsResolver
): Promise<{ url: URL; hostname: string; addresses: readonly ResolvedAddress[] }> {
  const url = validateExternalUrl(value);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);

  if (resolved.length === 0) {
    throw new SafeFetchError("DNS_FAILURE", "DNS resolution returned no addresses");
  }

  const addresses: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const record of resolved) {
    const detectedFamily = isIP(record.address);
    if (
      (detectedFamily !== 4 && detectedFamily !== 6) ||
      detectedFamily !== record.family
    ) {
      throw new SafeFetchError("DNS_FAILURE", "DNS returned an invalid address record");
    }
    if (!isPublicIpAddress(record.address)) {
      throw new SafeFetchError(
        "DISALLOWED_ADDRESS",
        "DNS resolved to a private, local, or reserved address"
      );
    }
    const key = `${record.family}:${record.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push({ address: record.address, family: record.family });
    }
  }

  return { url, hostname, addresses };
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : value
      ])
  );
}

function pinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedAddress[]
): LookupFunction {
  return (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== expectedHostname) {
      const error = new Error("Pinned DNS lookup hostname mismatch") as NodeJS.ErrnoException;
      error.code = "EAI_FAIL";
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        addresses.map((item) => ({ address: item.address, family: item.family }))
      );
      return;
    }
    const requestedFamily = options.family;
    const selected = addresses.find(
      (item) => !requestedFamily || requestedFamily === item.family
    );
    if (!selected) {
      const error = new Error("No pinned address for requested family") as NodeJS.ErrnoException;
      error.code = "EAI_ADDRFAMILY";
      callback(error, "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

export const systemPinnedRequester: PinnedRequester = async (options) => {
  const dispatcher = new Agent({
    connect: {
      lookup: pinnedLookup(options.hostname, options.addresses)
    },
    connections: 1,
    pipelining: 0,
    maxResponseSize: options.maxBytes,
    autoSelectFamily: true,
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs
  });

  try {
    const response = await request(options.url, {
      dispatcher,
      method: "GET",
      headers: {
        accept: options.allowedMimeTypes.join(", "),
        "user-agent": options.userAgent
      },
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > options.maxBytes) {
        throw new SafeFetchError(
          "RESPONSE_TOO_LARGE",
          `Response exceeds the ${options.maxBytes}-byte limit`
        );
      }
      chunks.push(bytes);
    }
    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      body: Buffer.concat(chunks, size)
    };
  } finally {
    await dispatcher.destroy();
  }
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new SafeFetchError("TIMEOUT", "Fetch timed out")),
      timeoutMs
    );
    timeout.unref();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new SafeFetchError(
      "FETCH_FAILED",
      `${label} must be an integer between 1 and ${maximum}`
    );
  }
  return value;
}

function nonNegativeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new SafeFetchError(
      "FETCH_FAILED",
      `${label} must be an integer between 0 and ${maximum}`
    );
  }
  return value;
}

function mimeType(headers: Readonly<Record<string, string>>): string {
  return (headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export async function safeFetch(
  value: string | URL,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs", 30_000);
  const maxBytes = positiveInteger(options.maxBytes ?? 2_097_152, "maxBytes", 10_000_000);
  const maxRedirects = nonNegativeInteger(
    options.maxRedirects ?? 3,
    "maxRedirects",
    10
  );
  const userAgent = (options.userAgent ?? DEFAULT_USER_AGENT).trim();
  if (!userAgent || userAgent.length > 256 || /[\r\n]/.test(userAgent)) {
    throw new SafeFetchError("FETCH_FAILED", "userAgent is invalid");
  }
  const allowedMimeTypes = new Set(
    (options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map((item) =>
      item.toLowerCase()
    )
  );
  if (allowedMimeTypes.size === 0) {
    throw new SafeFetchError("FETCH_FAILED", "At least one MIME type must be allowed");
  }

  const resolver = options.resolver ?? systemDnsResolver;
  const requester = options.requester ?? systemPinnedRequester;
  const requestedUrl = validateExternalUrl(value).toString();
  let current = requestedUrl;
  const visited = new Set<string>();
  const hops: FetchHopMetadata[] = [];
  const startedAt = Date.now();

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (visited.has(current)) {
      throw new SafeFetchError("REDIRECT_LOOP", "Redirect loop detected");
    }
    visited.add(current);
    const elapsed = Date.now() - startedAt;
    const remainingTimeout = timeoutMs - elapsed;
    if (remainingTimeout <= 0) {
      throw new SafeFetchError("TIMEOUT", "Fetch timed out");
    }

    const resolved = await withTimeout(
      resolveAndValidateExternalUrl(current, resolver),
      remainingTimeout
    );
    let response: PinnedResponse;
    try {
      response = await withTimeout(
        requester({
          ...resolved,
          timeoutMs: remainingTimeout,
          maxBytes,
          userAgent,
          allowedMimeTypes: [...allowedMimeTypes]
        }),
        remainingTimeout
      );
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw error;
      }
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new SafeFetchError("TIMEOUT", "Fetch timed out", { cause: error });
      }
      throw new SafeFetchError("FETCH_FAILED", "Fetch failed", { cause: error });
    }

    const normalizedHeaders = Object.fromEntries(
      Object.entries(response.headers).map(([name, headerValue]) => [
        name.toLowerCase(),
        headerValue
      ])
    );
    if (response.body.byteLength > maxBytes) {
      throw new SafeFetchError(
        "RESPONSE_TOO_LARGE",
        `Response exceeds the ${maxBytes}-byte limit`
      );
    }
    const declaredSize = Number(normalizedHeaders["content-length"]);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new SafeFetchError(
        "RESPONSE_TOO_LARGE",
        `Response exceeds the ${maxBytes}-byte limit`
      );
    }
    hops.push({
      url: resolved.url.toString(),
      resolvedAddresses: resolved.addresses.map((item) => item.address),
      status: response.status
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError("TOO_MANY_REDIRECTS", "Redirect limit exceeded");
      }
      const location = normalizedHeaders.location;
      if (!location) {
        throw new SafeFetchError("INVALID_REDIRECT", "Redirect response has no Location");
      }
      try {
        const nextUrl = validateExternalUrl(new URL(location, resolved.url));
        if (resolved.url.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new SafeFetchError(
            "INVALID_REDIRECT",
            "HTTPS-to-HTTP redirects are not allowed"
          );
        }
        current = nextUrl.toString();
      } catch (error) {
        if (error instanceof SafeFetchError) {
          throw error;
        }
        throw new SafeFetchError("INVALID_REDIRECT", "Redirect Location is invalid", {
          cause: error
        });
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError(
        "HTTP_ERROR",
        `Source returned HTTP status ${response.status}`
      );
    }
    const contentType = mimeType(normalizedHeaders);
    if (!contentType || !allowedMimeTypes.has(contentType)) {
      throw new SafeFetchError(
        "UNSUPPORTED_MIME_TYPE",
        contentType
          ? `MIME type ${contentType} is not allowed`
          : "Response Content-Type is required"
      );
    }
    const finalUrl = resolved.url.toString();
    let body = response.body;
    let text: string | undefined;
    let sanitized = false;
    let promptInjection: PromptInjectionAssessment | undefined;
    if (contentType === "text/html" || contentType === "application/xhtml+xml") {
      const sanitizedHtml = sanitizeExternalHtml(new TextDecoder().decode(response.body));
      body = new TextEncoder().encode(sanitizedHtml);
      text = externalHtmlToText(sanitizedHtml);
      sanitized = true;
      promptInjection = assessPromptInjection(text);
    } else if (contentType.startsWith("text/") || contentType === "application/json") {
      text = new TextDecoder().decode(response.body);
      promptInjection = assessPromptInjection(text);
    }
    return {
      requestedUrl,
      finalUrl,
      status: response.status,
      contentType,
      body,
      ...(text !== undefined ? { text } : {}),
      sanitized,
      ...(promptInjection ? { promptInjection } : {}),
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
      userAgent,
      redirectCount,
      hops,
      source: {
        hostname: resolved.hostname,
        protocol: resolved.url.protocol as "http:" | "https:"
      }
    };
  }
}
