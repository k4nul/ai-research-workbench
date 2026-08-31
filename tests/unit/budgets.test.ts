import { describe, expect, it } from "vitest";
import {
  checkRunBudget,
  DEFAULT_RUN_BUDGET,
  estimateProviderCost,
  parseModelPrices,
  type RunUsage
} from "@/lib/budgets";

const emptyUsage: RunUsage = {
  providerRequests: 0,
  searchRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  costStatus: "KNOWN",
  elapsedMs: 0,
  stageAttempts: 0,
  sources: 0,
  documentChunks: 0
};

describe("provider cost and run budgets", () => {
  it("never treats missing model prices or token usage as zero cost", () => {
    expect(
      estimateProviderCost({
        provider: "openai-responses",
        model: "unconfigured-model",
        inputTokens: 10,
        outputTokens: 5,
        prices: parseModelPrices(undefined)
      })
    ).toEqual({ status: "UNKNOWN", estimatedCostUsd: null });
  });

  it("estimates configured model cost from one centralized price record", () => {
    const prices = parseModelPrices(
      JSON.stringify([
        {
          provider: "fixture",
          model: "fixture-model",
          inputUsdPerMillionTokens: 2,
          outputUsdPerMillionTokens: 8,
          status: "ESTIMATED",
          effectiveAt: "2026-08-30",
          source: "synthetic test fixture"
        }
      ])
    );
    expect(
      estimateProviderCost({
        provider: "fixture",
        model: "fixture-model",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        prices
      })
    ).toEqual({ status: "ESTIMATED", estimatedCostUsd: 6 });
  });

  it("blocks the next provider request on unknown cost or projected limits", () => {
    expect(
      checkRunBudget(DEFAULT_RUN_BUDGET, emptyUsage, {
        providerRequests: 1,
        costStatus: "UNKNOWN"
      })
    ).toEqual({ allowed: false, violations: ["UNKNOWN_MODEL_COST"] });

    expect(
      checkRunBudget(
        { ...DEFAULT_RUN_BUDGET, maxProviderRequests: 1 },
        { ...emptyUsage, providerRequests: 1 },
        { providerRequests: 1 }
      )
    ).toEqual({ allowed: false, violations: ["MAX_PROVIDER_REQUESTS"] });
  });

  it("accepts an in-budget deterministic mock execution", () => {
    expect(
      checkRunBudget(DEFAULT_RUN_BUDGET, emptyUsage, {
        providerRequests: 1,
        inputTokens: 1_000,
        outputTokens: 500,
        estimatedCostUsd: 0,
        costStatus: "KNOWN",
        stageAttempts: 1
      })
    ).toEqual({ allowed: true, violations: [] });
  });
});
