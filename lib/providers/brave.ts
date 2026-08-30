import { createHash } from "node:crypto";
import { externalHtmlToText, validateExternalUrl } from "@/lib/security";
import type {
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

  constructor(options: BraveSearchProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.userAgent = options.userAgent ?? "ai-research-workbench/0.1";
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new Error("Brave timeout must be an integer between 1000 and 30000 ms");
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(input: SearchQuery): Promise<SearchResponse> {
    if (!this.apiKey) {
      throw new Error("Brave Search is not configured");
    }
    const query = validateSearchQuery(input);
    const startedAt = this.now();
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
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
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
          "User-Agent": this.userAgent
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error("Brave Search request timed out", { cause: error });
      }
      throw new Error("Brave Search request failed", { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Brave Search returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    return {
      provider: this.id,
      query: query.query,
      results: parseHits(payload, query.count),
      metadata: {
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id") ?? undefined }
          : {})
      }
    };
  }
}

export { BRAVE_SEARCH_ENDPOINT };
