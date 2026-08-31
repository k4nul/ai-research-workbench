import { createHash } from "node:crypto";
import { externalHtmlToText, validateExternalUrl } from "@/lib/security";
import {
  braveResetMs,
  classifyFetchFailure,
  composeAbortSignal,
  ProviderRequestError,
  readJsonWithLimit,
  retryAfterMs
} from "./execution";
import type {
  ProviderExecutionOptions,
  SearchHit,
  SearchProvider,
  SearchQuery,
  SearchResponse
} from "./types";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveSearchProviderOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  userAgent?: string;
  endpoint?: string;
  maxResponseBytes?: number;
}

function validateSearchQuery(input: SearchQuery): Required<
  Pick<SearchQuery, "query" | "count" | "safeSearch">
> &
  Omit<SearchQuery, "query" | "count" | "safeSearch"> {
  const query = input.query.trim();
  if (!query || query.length > 400 || query.split(/\s+/).length > 50) {
    throw new Error("Search query must contain 1-400 characters and at most 50 words");
  }
  const count = input.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Search count must be an integer between 1 and 20");
  }
  if (input.country && !/^[A-Za-z]{2}$/.test(input.country)) {
    throw new Error("Search country must be a two-letter country code");
  }
  if (input.searchLanguage && !/^[A-Za-z]{2,8}$/.test(input.searchLanguage)) {
    throw new Error("Search language is invalid");
  }
  if (input.uiLanguage && !/^[A-Za-z]{2,3}-[A-Za-z]{2}$/.test(input.uiLanguage)) {
    throw new Error("Search UI language is invalid");
  }
  if (
    input.freshness &&
    !/^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/.test(input.freshness)
  ) {
    throw new Error("Search freshness filter is invalid");
  }
  return {
    ...input,
    query,
    count,
    safeSearch: input.safeSearch ?? "moderate"
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resultId(url: string): string {
  return `brave-${createHash("sha256").update(url).digest("hex").slice(0, 20)}`;
}

function publishedDate(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(candidate)) {
    return undefined;
  }
  return Number.isNaN(Date.parse(candidate)) ? undefined : candidate;
}

function parseHits(payload: unknown, count: number): SearchHit[] {
  const root = record(payload);
  const web = record(root?.web);
  const results = Array.isArray(web?.results) ? web.results : [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of results) {
    const item = record(raw);
    const rawUrl = stringValue(item?.url);
    const rawTitle = stringValue(item?.title);
    if (!rawUrl || !rawTitle) {
      continue;
    }
    let url: string;
    try {
      url = validateExternalUrl(rawUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    const publishedAt =
      publishedDate(item?.page_age) ??
      publishedDate(item?.published_time) ??
      publishedDate(item?.publishedAt);
    hits.push({
      id: resultId(url),
      title: externalHtmlToText(rawTitle),
      url,
      snippet: externalHtmlToText(stringValue(item?.description) ?? ""),
      ...(publishedAt ? { publishedAt } : {}),
      ...(stringValue(item?.language)
        ? { language: stringValue(item?.language) }
        : {})
    });
    if (hits.length >= count) {
      break;
    }
  }
  return hits;
}

export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave-search";
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly userAgent: string;
  private readonly endpoint: string;
  private readonly maxResponseBytes: number;

  constructor(options: BraveSearchProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.userAgent = options.userAgent ?? "ai-research-workbench/0.2";
    this.endpoint = options.endpoint ?? BRAVE_SEARCH_ENDPOINT;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new Error("Brave timeout must be an integer between 1000 and 30000 ms");
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 10_000_000
    ) {
      throw new Error("Brave maxResponseBytes must be an integer between 1024 and 10000000");
    }
    const endpoint = new URL(this.endpoint);
    if (
      endpoint.protocol !== "https:" &&
      endpoint.hostname !== "127.0.0.1" &&
      endpoint.hostname !== "localhost"
    ) {
      throw new Error(
        "Brave endpoint must use HTTPS except for a loopback contract-test server"
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(
    input: SearchQuery,
    options: ProviderExecutionOptions = {}
  ): Promise<SearchResponse> {
    if (!this.apiKey) {
      throw new ProviderRequestError("Brave Search is not configured", {
        classification: "NON_RETRYABLE_USER_INPUT",
        retryable: false
      });
    }
    const query = validateSearchQuery(input);
    const startedAt = this.now();
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query.query);
    url.searchParams.set("count", String(query.count));
    url.searchParams.set("safesearch", query.safeSearch);
    url.searchParams.set("result_filter", "web");
    url.searchParams.set("text_decorations", "false");
    if (query.country) {
      url.searchParams.set("country", query.country.toUpperCase());
    }
    if (query.searchLanguage) {
      url.searchParams.set("search_lang", query.searchLanguage.toLowerCase());
    }
    if (query.uiLanguage) {
      const [language, country] = query.uiLanguage.split("-");
      url.searchParams.set("ui_lang", `${language.toLowerCase()}-${country.toUpperCase()}`);
    }
    if (query.freshness) {
      url.searchParams.set("freshness", query.freshness);
    }

    let response: Response;
    const abort = composeAbortSignal(this.timeoutMs, options.signal);
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
          "User-Agent": this.userAgent
        },
        signal: abort.signal
      });
    } catch (error) {
      const classified = classifyFetchFailure(
        error,
        options.signal,
        abort.timeoutSignal
      );
      throw new ProviderRequestError(
        classified.classification === "CANCELLED"
          ? "Brave Search request was cancelled"
          : abort.timeoutSignal.aborted
            ? "Brave Search request timed out"
            : "Brave Search request failed",
        {
          classification: classified.classification,
          retryable: classified.retryable,
          cause: error
        }
      );
    }
    if (!response.ok) {
      const rateLimited = response.status === 429;
      const serverError = response.status >= 500;
      throw new ProviderRequestError(`Brave Search returned HTTP ${response.status}`, {
        classification: rateLimited
          ? "RETRYABLE_PROVIDER_RATE_LIMIT"
          : serverError
            ? "RETRYABLE_PROVIDER_SERVER_ERROR"
            : "NON_RETRYABLE_USER_INPUT",
        retryable: rateLimited || serverError,
        httpStatus: response.status,
        retryAfterMs: rateLimited
          ? retryAfterMs(response.headers) ?? braveResetMs(response.headers)
          : undefined,
        requestId: response.headers.get("x-request-id") ?? undefined
      });
    }
    const payload = await readJsonWithLimit(response, this.maxResponseBytes);
    return {
      provider: this.id,
      query: query.query,
      results: parseHits(payload, query.count),
      metadata: {
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id") ?? undefined }
          : {}),
        rateLimit: {
          limit: response.headers.get("x-ratelimit-limit") ?? undefined,
          remaining: response.headers.get("x-ratelimit-remaining") ?? undefined,
          reset: response.headers.get("x-ratelimit-reset") ?? undefined
        }
      }
    };
  }
}

export { BRAVE_SEARCH_ENDPOINT };
