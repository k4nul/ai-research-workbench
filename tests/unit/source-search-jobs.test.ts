import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "@/lib/providers";
import { sourceSearchRequestSchema } from "@/lib/services/source-search-jobs";
import { JobExecutionError } from "@/worker/durable-worker";
import { sourceSearchExecutionError } from "@/worker/source-search-handler";

describe("durable source-search boundaries", () => {
  it("normalizes bounded legacy search input for durable submission", () => {
    expect(
      sourceSearchRequestSchema.parse({
        query: "  synthetic evidence  ",
        count: "2",
        country: "kr",
        searchLanguage: "EN"
      })
    ).toMatchObject({
      query: "synthetic evidence",
      count: 2,
      country: "KR",
      searchLanguage: "en",
      safeSearch: "moderate"
    });
    expect(() =>
      sourceSearchRequestSchema.parse({ query: "fixture", count: 21 })
    ).toThrow();
  });

  it("maps provider retry metadata to the durable job error contract", () => {
    const error = sourceSearchExecutionError(
      new ProviderRequestError("Brave Search is rate limited", {
        classification: "RETRYABLE_PROVIDER_RATE_LIMIT",
        retryable: true,
        retryAfterMs: 2_500,
        requestId: "search-request-fixture"
      })
    );
    expect(error).toBeInstanceOf(JobExecutionError);
    expect(error).toMatchObject({
      errorClass: "RETRYABLE_PROVIDER_RATE_LIMIT",
      retryAfterMs: 2_500
    });
  });

  it("preserves worker timeout classification over late provider results", () => {
    const controller = new AbortController();
    controller.abort(
      new JobExecutionError("Search execution timed out.", "RETRYABLE_TIMEOUT")
    );
    expect(
      sourceSearchExecutionError(new Error("late provider failure"), controller.signal)
    ).toMatchObject({ errorClass: "RETRYABLE_TIMEOUT" });
    expect(
      sourceSearchExecutionError(
        new ProviderRequestError("Brave Search request timed out", {
          classification: "RETRYABLE_NETWORK",
          retryable: true
        })
      )
    ).toMatchObject({ errorClass: "RETRYABLE_TIMEOUT" });
  });
});
