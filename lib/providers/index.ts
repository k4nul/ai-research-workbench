import { maskSecret } from "@/lib/config";
import { BraveSearchProvider } from "./brave";
import { MockAIProvider } from "./mock-ai";
import { MockSearchProvider } from "./mock-search";
import { OpenAIResponsesProvider } from "./openai";
import type {
  AIProvider,
  ProviderStatus,
  SearchProvider
} from "./types";

export * from "./brave";
export * from "./mock-ai";
export * from "./mock-search";
export * from "./openai";
export * from "./types";

export interface ProviderSelectionConfig {
  demoMode: boolean;
  openAiApiKey?: string;
  openAiModel: string;
  braveSearchApiKey?: string;
  timeoutMs?: number;
}

export interface ProviderSelection {
  ai: AIProvider;
  search: SearchProvider;
  statuses: readonly ProviderStatus[];
}

export function selectProviders(config: ProviderSelectionConfig): ProviderSelection {
  const openAi = new OpenAIResponsesProvider({
    apiKey: config.openAiApiKey,
    model: config.openAiModel,
    timeoutMs: config.timeoutMs
  });
  const brave = new BraveSearchProvider({
    apiKey: config.braveSearchApiKey,
    timeoutMs: config.timeoutMs
  });
  const mockAi = new MockAIProvider();
  const mockSearch = new MockSearchProvider();
  const useOpenAi = !config.demoMode && openAi.isConfigured();
  const useBrave = !config.demoMode && brave.isConfigured();

  return {
    ai: useOpenAi ? openAi : mockAi,
    search: useBrave ? brave : mockSearch,
    statuses: [
      {
        kind: "ai",
        provider: mockAi.id,
        active: !useOpenAi,
        configured: true,
        mode: "mock",
        model: mockAi.model,
        credential: "not required"
      },
      {
        kind: "ai",
        provider: openAi.id,
        active: useOpenAi,
        configured: openAi.isConfigured(),
        mode: "live",
        model: openAi.model,
        credential: maskSecret(config.openAiApiKey)
      },
      {
        kind: "search",
        provider: mockSearch.id,
        active: !useBrave,
        configured: true,
        mode: "mock",
        credential: "not required"
      },
      {
        kind: "search",
        provider: brave.id,
        active: useBrave,
        configured: brave.isConfigured(),
        mode: "live",
        credential: maskSecret(config.braveSearchApiKey)
      }
    ]
  };
}
