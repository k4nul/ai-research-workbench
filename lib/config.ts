import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().default("postgresql://research:research@localhost:55432/research_workbench"),
  DEMO_MODE: z.enum(["true", "false"]).default("true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3100"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(25_000_000).default(5_242_880),
  MAX_FETCH_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_097_152),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  STORAGE_DIR: z.string().min(1).default("./.data")
});

export type AppConfig = {
  databaseUrl: string;
  demoMode: boolean;
  openAiApiKey?: string;
  openAiModel: string;
  braveSearchApiKey?: string;
  appUrl: string;
  maxUploadBytes: number;
  maxFetchBytes: number;
  fetchTimeoutMs: number;
  storageDir: string;
};

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = environmentSchema.parse(process.env);
  cachedConfig = {
    databaseUrl: parsed.DATABASE_URL,
    demoMode: parsed.DEMO_MODE === "true",
    openAiApiKey: parsed.OPENAI_API_KEY || undefined,
    openAiModel: parsed.OPENAI_MODEL,
    braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY || undefined,
    appUrl: parsed.APP_URL,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxFetchBytes: parsed.MAX_FETCH_BYTES,
    fetchTimeoutMs: parsed.FETCH_TIMEOUT_MS,
    storageDir: parsed.STORAGE_DIR
  };
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}

export function maskSecret(value: string | undefined): string {
  if (!value) {
    return "not configured";
  }
  if (value.length < 8) {
    return "••••";
  }
  return value.slice(0, 3) + "••••" + value.slice(-3);
}
