import "dotenv/config";
import { randomUUID } from "node:crypto";
import { BraveSearchProvider, OpenAIResponsesProvider } from "../lib/providers/index.js";
import { closePool, query } from "../lib/db.js";

type CanaryStatus = "PASSED" | "FAILED" | "NOT_RUN_NO_CREDENTIALS";

interface CanaryResult {
  provider: string;
  model?: string;
  status: CanaryStatus;
  requestId?: string;
  latencyMs?: number;
  usage?: unknown;
  error?: string;
}

function hasUsage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return ["inputTokens", "outputTokens", "totalTokens"].every(
    (key) => typeof usage[key] === "number" && Number.isFinite(usage[key])
  );
}

async function openAiCanary(): Promise<CanaryResult> {
  if (!process.env.OPENAI_API_KEY) {
    return { provider: "openai-responses", status: "NOT_RUN_NO_CREDENTIALS" };
  }
  const provider = new OpenAIResponsesProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    timeoutMs: 20_000,
    maxOutputTokens: 512
  });
  const result = await provider.run(
    {
      stage: "intake_analysis",
      projectId: "synthetic-live-canary",
      promptTemplateVersion: "canary-v1",
      allowedSourceIds: [],
      input: {
        brief:
          "Synthetic compatibility canary: describe a bounded research check without using external facts.",
        asOfDate: "2026-08-30"
      }
    },
    { clientRequestId: `canary-${Date.now()}` }
  );
  if (result.success) {
    const requestId = result.metadata.requestId;
    const usage = result.metadata.usage;
    const compatible = Boolean(requestId) && hasUsage(usage);
    return {
        provider: provider.id,
        model: provider.model,
        status: compatible ? "PASSED" : "FAILED",
        requestId,
        latencyMs: result.metadata.durationMs,
        usage,
        ...(compatible ? {} : { error: "MISSING_REQUEST_ID_OR_USAGE" })
      };
  }
  return {
        provider: provider.id,
        model: provider.model,
        status: "FAILED",
        requestId: result.metadata.requestId,
        latencyMs: result.metadata.durationMs,
        error: result.error.code
      };
}

async function braveCanary(): Promise<CanaryResult> {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    return { provider: "brave-search", status: "NOT_RUN_NO_CREDENTIALS" };
  }
  const provider = new BraveSearchProvider({
    apiKey: process.env.BRAVE_SEARCH_API_KEY,
    timeoutMs: 10_000
  });
  try {
    const result = await provider.search({
      query: "OpenAI API official documentation",
      count: 1,
      safeSearch: "strict"
    });
    const compatible = result.results.length > 0 && Boolean(result.metadata.requestId);
    return {
      provider: provider.id,
      status: compatible ? "PASSED" : "FAILED",
      requestId: result.metadata.requestId,
      latencyMs: result.metadata.durationMs,
      ...(compatible
        ? {}
        : { error: result.results.length === 0 ? "NO_RESULTS" : "MISSING_REQUEST_ID" })
    };
  } catch (error) {
    return {
      provider: provider.id,
      status: "FAILED",
      error: error instanceof Error ? error.name : "UNKNOWN"
    };
  }
}

async function main(): Promise<void> {
  const results = await Promise.all([openAiCanary(), braveCanary()]);
  await Promise.all(
    results.map((result) =>
      query(
        "INSERT INTO provider_canary_runs (id, provider, model, status, request_id, latency_ms, usage, sanitized_error, synthetic_input) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, TRUE)",
        [
          randomUUID(),
          result.provider,
          result.model ?? null,
          result.status,
          result.requestId ?? null,
          result.latencyMs ?? null,
          JSON.stringify(result.usage ?? {}),
          result.error?.replace(/[\r\n\t]+/g, " ").slice(0, 500) ?? null
        ]
      )
    )
  );
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: "provider-canary-v1",
        syntheticInput: true,
        accuracyScore: null,
        results
      },
      null,
      2
    ) + "\n"
  );
  if (results.some((result) => result.status === "FAILED")) process.exitCode = 1;
}

await main().finally(() => closePool());
