import { createHash } from "node:crypto";
import type {
  SearchHit,
  SearchProvider,
  SearchQuery,
  SearchResponse
} from "./types";

const DEFAULT_FIXTURES: readonly SearchHit[] = [
  {
    id: "mock-official-guidance",
    title: "Sample official guidance",
    url: "https://example.org/official-guidance",
    snippet: "Synthetic primary-source guidance for the no-key demo workflow.",
    publishedAt: "2026-01-15",
    language: "en"
  },
  {
    id: "mock-market-analysis",
    title: "Sample market analysis",
    url: "https://example.org/market-analysis",
    snippet: "Synthetic comparative evidence for research planning and claims.",
    publishedAt: "2025-11-02",
    language: "en"
  },
  {
    id: "mock-korean-source",
    title: "샘플 공식 자료",
    url: "https://example.org/ko/sample",
    snippet: "API 키 없이 동작하는 리서치 데모용 합성 자료입니다.",
    publishedAt: "2026-02-01",
    language: "ko"
  }
];

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function queryCount(value: number | undefined): number {
  const count = value ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Search count must be an integer between 1 and 20");
  }
  return count;
}

function validateQuery(value: string): string {
  const query = value.trim();
  if (!query || query.length > 400 || query.split(/\s+/).length > 50) {
    throw new Error("Search query must contain 1-400 characters and at most 50 words");
  }
  return query;
}

export class MockSearchProvider implements SearchProvider {
  readonly id = "mock-search";

  constructor(
    private readonly fixtures: readonly SearchHit[] = DEFAULT_FIXTURES,
    private readonly now: () => Date = () => new Date()
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async search(input: SearchQuery): Promise<SearchResponse> {
    const startedAt = this.now();
    const query = validateQuery(input.query);
    const queryTokens = tokens(query);
    const count = queryCount(input.count);
    const ranked = this.fixtures
      .map((fixture) => {
        const searchable = tokens(`${fixture.title} ${fixture.snippet}`);
        const score = [...queryTokens].filter((token) => searchable.has(token)).length;
        return { fixture, score };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.fixture.id.localeCompare(right.fixture.id)
      );
    const matching = ranked.some((item) => item.score > 0)
      ? ranked.filter((item) => item.score > 0)
      : ranked;
    return {
      provider: this.id,
      query,
      results: matching.slice(0, count).map(({ fixture }) => ({ ...fixture })),
      metadata: {
        startedAt: startedAt.toISOString(),
        durationMs: 0,
        requestId: `mock-${createHash("sha256").update(query).digest("hex").slice(0, 12)}`
      }
    };
  }
}
