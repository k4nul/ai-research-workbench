export type CostStatus = "KNOWN" | "ESTIMATED" | "UNKNOWN";

export interface ModelPrice {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  status: Exclude<CostStatus, "UNKNOWN">;
  effectiveAt: string;
  source: string;
}

export interface BudgetSnapshot {
  maxProviderRequests: number;
  maxSearchRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxEstimatedCostUsd: number;
  maxElapsedMs: number;
  maxStageAttempts: number;
  maxSources: number;
  maxDocumentChunks: number;
}

export interface RunUsage {
  providerRequests: number;
  searchRequests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  elapsedMs: number;
  stageAttempts: number;
  sources: number;
  documentChunks: number;
}

export interface BudgetDecision {
  allowed: boolean;
  violations: readonly string[];
}

export const DEFAULT_RUN_BUDGET: Readonly<BudgetSnapshot> = {
  maxProviderRequests: 40,
  maxSearchRequests: 30,
  maxInputTokens: 500_000,
  maxOutputTokens: 100_000,
  maxEstimatedCostUsd: 25,
  maxElapsedMs: 60 * 60 * 1_000,
  maxStageAttempts: 3,
  maxSources: 100,
  maxDocumentChunks: 2_000
};

const BUILT_IN_PRICES: readonly ModelPrice[] = [
  {
    provider: "mock-ai",
    model: "deterministic-fixture-v1",
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    status: "KNOWN",
    effectiveAt: "2026-08-30",
    source: "deterministic local provider; no external API call"
  }
];

export function parseModelPrices(value: string | undefined): readonly ModelPrice[] {
  if (!value?.trim()) {
    return BUILT_IN_PRICES;
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("MODEL_PRICING_JSON must be an array");
  }
  const configured = parsed.map((item, index): ModelPrice => {
    if (!item || typeof item !== "object") {
      throw new Error(`MODEL_PRICING_JSON[${index}] must be an object`);
    }
    const price = item as Record<string, unknown>;
    const provider = typeof price.provider === "string" ? price.provider.trim() : "";
    const model = typeof price.model === "string" ? price.model.trim() : "";
    const input = Number(price.inputUsdPerMillionTokens);
    const output = Number(price.outputUsdPerMillionTokens);
    const status = price.status;
    const effectiveAt = typeof price.effectiveAt === "string" ? price.effectiveAt : "";
    const source = typeof price.source === "string" ? price.source.trim() : "";
    if (
      !provider ||
      !model ||
      !Number.isFinite(input) ||
      input < 0 ||
      !Number.isFinite(output) ||
      output < 0 ||
      (status !== "KNOWN" && status !== "ESTIMATED") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(effectiveAt) ||
      !source
    ) {
      throw new Error(`MODEL_PRICING_JSON[${index}] is invalid`);
    }
    return {
      provider,
      model,
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output,
      status,
      effectiveAt,
      source
    };
  });
  const keys = configured.map((price) => `${price.provider}\0${price.model}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("MODEL_PRICING_JSON contains duplicate provider/model entries");
  }
  return [...BUILT_IN_PRICES, ...configured];
}

export function estimateProviderCost(input: {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  prices: readonly ModelPrice[];
}): { status: CostStatus; estimatedCostUsd: number | null } {
  const price = input.prices.find(
    (candidate) =>
      candidate.provider === input.provider && candidate.model === input.model
  );
  if (!price || input.inputTokens === undefined || input.outputTokens === undefined) {
    return { status: "UNKNOWN", estimatedCostUsd: null };
  }
  const estimatedCostUsd =
    (input.inputTokens * price.inputUsdPerMillionTokens +
      input.outputTokens * price.outputUsdPerMillionTokens) /
    1_000_000;
  return { status: price.status, estimatedCostUsd };
}

export function checkRunBudget(
  budget: BudgetSnapshot,
  usage: RunUsage,
  next: Partial<RunUsage> = {}
): BudgetDecision {
  const projected = {
    providerRequests: usage.providerRequests + (next.providerRequests ?? 0),
    searchRequests: usage.searchRequests + (next.searchRequests ?? 0),
    inputTokens: usage.inputTokens + (next.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (next.outputTokens ?? 0),
    estimatedCostUsd: usage.estimatedCostUsd + (next.estimatedCostUsd ?? 0),
    elapsedMs: usage.elapsedMs + (next.elapsedMs ?? 0),
    stageAttempts: usage.stageAttempts + (next.stageAttempts ?? 0),
    sources: usage.sources + (next.sources ?? 0),
    documentChunks: usage.documentChunks + (next.documentChunks ?? 0)
  };
  const violations: string[] = [];
  const checks: readonly [keyof typeof projected, number, string][] = [
    ["providerRequests", budget.maxProviderRequests, "MAX_PROVIDER_REQUESTS"],
    ["searchRequests", budget.maxSearchRequests, "MAX_SEARCH_REQUESTS"],
    ["inputTokens", budget.maxInputTokens, "MAX_INPUT_TOKENS"],
    ["outputTokens", budget.maxOutputTokens, "MAX_OUTPUT_TOKENS"],
    ["estimatedCostUsd", budget.maxEstimatedCostUsd, "MAX_ESTIMATED_COST"],
    ["elapsedMs", budget.maxElapsedMs, "MAX_ELAPSED_TIME"],
    ["stageAttempts", budget.maxStageAttempts, "MAX_STAGE_ATTEMPTS"],
    ["sources", budget.maxSources, "MAX_SOURCES"],
    ["documentChunks", budget.maxDocumentChunks, "MAX_DOCUMENT_CHUNKS"]
  ];
  for (const [key, maximum, code] of checks) {
    if (projected[key] > maximum) {
      violations.push(code);
    }
  }
  const costStatus = next.costStatus ?? usage.costStatus;
  if (
    projected.providerRequests > usage.providerRequests &&
    costStatus === "UNKNOWN" &&
    Number.isFinite(budget.maxEstimatedCostUsd)
  ) {
    violations.push("UNKNOWN_MODEL_COST");
  }
  return { allowed: violations.length === 0, violations };
}
