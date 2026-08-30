import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { query } from "@/lib/db";
import { selectProviders } from "@/lib/providers";
import {
  assessPromptInjection,
  externalHtmlToText,
  safeFetch,
  sanitizeExternalHtml,
  validateUploadedFile,
  FileValidationError,
  SafeFetchError
} from "@/lib/security";
import { addSource } from "@/lib/services/sources";
import { AppError } from "@/lib/services/errors";
import { sourceInputSchema } from "@/lib/validation";

function providerSelection() {
  const config = getConfig();
  return selectProviders({
    demoMode: config.demoMode,
    openAiApiKey: config.openAiApiKey,
    openAiModel: config.openAiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    timeoutMs: config.fetchTimeoutMs
  });
}

export async function searchAndRegisterSources(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = z
    .object({
      query: z.string().trim().min(1).max(400),
      count: z.coerce.number().int().min(1).max(20).default(5),
      country: z.string().trim().length(2).optional(),
      searchLanguage: z.string().trim().min(2).max(10).optional(),
      freshness: z.enum(["pd", "pw", "pm", "py"]).optional()
    })
    .parse(rawInput);
  const selection = providerSelection();
  const response = await selection.search.search(input);
  const registered: Record<string, unknown>[] = [];
  for (const hit of response.results) {
    registered.push(
      await addSource(projectId, {
        url: hit.url,
        title: hit.title,
        publisher: new URL(hit.url).hostname,
        publishedAt: hit.publishedAt,
        sourceType: "SEARCH_RESULT",
        language: hit.language ?? input.searchLanguage ?? "en",
        reliabilityGrade: "UNRATED",
        contentSummary: hit.snippet,
        ingestionMethod: "SEARCH",
        mimeType: "text/html"
      })
    );
  }
  return { search: response, registered };
}

export async function fetchAndRegisterSource(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = z
    .object({
      url: z.string().url(),
      title: z.string().trim().min(2).max(500).optional(),
      publisher: z.string().trim().max(500).optional(),
      author: z.string().trim().max(500).optional(),
      publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sourceType: z.string().trim().min(2).max(80).default("WEB"),
      language: z.string().trim().min(2).max(20).default("en"),
      reliabilityGrade: z.enum(["A", "B", "C", "D", "UNRATED"]).default("UNRATED"),
      usageRestrictions: z.string().trim().max(2_000).optional()
    })
    .parse(rawInput);
  const config = getConfig();
  try {
    const fetched = await safeFetch(input.url, {
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.maxFetchBytes,
      maxRedirects: 3,
      allowedMimeTypes: [
        "application/json",
        "application/xhtml+xml",
        "text/csv",
        "text/html",
        "text/markdown",
        "text/plain"
      ],
      userAgent: "ai-research-workbench/0.1 research-source-fetcher"
    });
    const text = fetched.text ?? new TextDecoder().decode(fetched.body);
    const sanitizedContent = fetched.contentType.includes("html")
      ? externalHtmlToText(text)
      : text.replace(/\0/g, "").slice(0, config.maxFetchBytes);
    const injection = fetched.promptInjection ?? assessPromptInjection(sanitizedContent);
    const source = await addSource(projectId, {
      url: fetched.finalUrl,
      title: input.title ?? fetched.finalUrl,
      publisher: input.publisher ?? fetched.source.hostname,
      author: input.author,
      publishedAt: input.publishedAt,
      sourceType: input.sourceType,
      language: input.language,
      reliabilityGrade: input.reliabilityGrade,
      usageRestrictions: input.usageRestrictions,
      contentSummary: sanitizedContent.slice(0, 1_500),
      sanitizedContent,
      ingestionMethod: "FETCH",
      mimeType: fetched.contentType
    });
    await query(
      "UPDATE sources SET prompt_injection_flag = $2, fetch_metadata = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [
        source.id,
        injection.flagged,
        JSON.stringify({
          requestedUrl: fetched.requestedUrl,
          finalUrl: fetched.finalUrl,
          fetchedAt: fetched.fetchedAt,
          userAgent: fetched.userAgent,
          redirectCount: fetched.redirectCount,
          hops: fetched.hops,
          promptInjection: injection
        })
      ]
    );
    return { ...source, prompt_injection_flag: injection.flagged };
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new AppError(422, error.code, error.message);
    }
    throw error;
  }
}

function textFromUpload(
  extension: string,
  mimeType: string,
  bytes: Uint8Array
): { content?: string; summary: string } {
  if ([".pdf", ".docx"].includes(extension)) {
    return {
      summary:
        "Validated binary upload. Add evidence manually or connect a document-extraction adapter."
    };
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (mimeType === "text/html") {
    const sanitized = sanitizeExternalHtml(raw);
    return {
      content: externalHtmlToText(sanitized),
      summary: externalHtmlToText(sanitized).slice(0, 1_500)
    };
  }
  if (mimeType === "application/json") {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    return { content: formatted, summary: formatted.slice(0, 1_500) };
  }
  return { content: raw, summary: raw.replace(/\s+/g, " ").slice(0, 1_500) };
}

export async function uploadAndRegisterSource(
  projectId: string,
  file: File,
  metadata: {
    title?: string;
    publisher?: string;
    author?: string;
    publishedAt?: string;
    sourceType?: string;
    language?: string;
    reliabilityGrade?: string;
    usageRestrictions?: string;
  }
): Promise<Record<string, unknown>> {
  const config = getConfig();
  if (file.size > config.maxUploadBytes) {
    throw new AppError(413, "INVALID_SIZE", "The upload exceeds the configured size limit.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const validated = validateUploadedFile(
      {
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        bytes
      },
      { maxBytes: config.maxUploadBytes }
    );
    const parsedMetadata = z
      .object({
        title: z.string().trim().min(2).max(500).optional(),
        publisher: z.string().trim().max(500).optional(),
        author: z.string().trim().max(500).optional(),
        publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sourceType: z.string().trim().min(2).max(80).default("UPLOAD"),
        language: z.string().trim().min(2).max(20).default("en"),
        reliabilityGrade: z.enum(["A", "B", "C", "D", "UNRATED"]).default("UNRATED"),
        usageRestrictions: z.string().trim().max(2_000).optional()
      })
      .parse(metadata);
    const extracted = textFromUpload(validated.extension, validated.mimeType, bytes);
    const injection = assessPromptInjection(extracted.content ?? "");
    const source = await addSource(projectId, {
      title: parsedMetadata.title ?? validated.safeFilename,
      publisher: parsedMetadata.publisher,
      author: parsedMetadata.author,
      publishedAt: parsedMetadata.publishedAt,
      sourceType: parsedMetadata.sourceType,
      language: parsedMetadata.language,
      reliabilityGrade: parsedMetadata.reliabilityGrade,
      usageRestrictions: parsedMetadata.usageRestrictions,
      contentSummary: extracted.summary,
      sanitizedContent: extracted.content,
      ingestionMethod: "UPLOAD",
      mimeType: validated.mimeType
    });

    const storageRoot = path.resolve(config.storageDir, "uploads");
    const projectDirectory = path.resolve(storageRoot, projectId);
    if (!projectDirectory.startsWith(storageRoot + path.sep)) {
      throw new Error("Upload path escaped the configured storage root.");
    }
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    const storageName = randomUUID() + "-" + validated.safeFilename;
    const storagePath = path.resolve(projectDirectory, storageName);
    if (!storagePath.startsWith(projectDirectory + path.sep)) {
      throw new Error("Upload filename escaped the project directory.");
    }
    await writeFile(storagePath, bytes, { mode: 0o600 });
    await query(
      "UPDATE sources SET prompt_injection_flag = $2, fetch_metadata = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [
        source.id,
        injection.flagged,
        JSON.stringify({
          originalFilename: validated.originalFilename,
          safeFilename: validated.safeFilename,
          storagePath,
          size: validated.size,
          promptInjection: injection
        })
      ]
    );
    return { ...source, prompt_injection_flag: injection.flagged };
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw new AppError(422, error.code, error.message);
    }
    throw error;
  }
}

export async function importSources(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>[]> {
  const input = z
    .object({
      format: z.enum(["json", "markdown"]),
      content: z.string().min(2).max(500_000)
    })
    .parse(rawInput);
  let sourceInputs: unknown[];
  if (input.format === "json") {
    const parsed: unknown = JSON.parse(input.content);
    sourceInputs = Array.isArray(parsed)
      ? parsed
      : z.object({ sources: z.array(z.unknown()) }).parse(parsed).sources;
  } else {
    const title =
      input.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Imported Markdown source";
    const url = input.content.match(/^URL:\s*(\S+)$/im)?.[1];
    const publisher = input.content.match(/^Publisher:\s*(.+)$/im)?.[1]?.trim();
    const publishedAt = input.content.match(/^Published:\s*(\d{4}-\d{2}-\d{2})$/im)?.[1];
    sourceInputs = [
      {
        title,
        url,
        publisher,
        publishedAt,
        sourceType: "MARKDOWN_IMPORT",
        reliabilityGrade: "UNRATED",
        contentSummary: input.content.replace(/\s+/g, " ").slice(0, 1_500),
        sanitizedContent: input.content,
        ingestionMethod: "IMPORT",
        mimeType: "text/markdown"
      }
    ];
  }
  if (sourceInputs.length > 100) {
    throw new AppError(413, "IMPORT_TOO_LARGE", "A source import is limited to 100 records.");
  }
  const registered: Record<string, unknown>[] = [];
  for (const source of sourceInputs) {
    registered.push(
      await addSource(
        projectId,
        sourceInputSchema.parse({ ...z.record(z.string(), z.unknown()).parse(source), ingestionMethod: "IMPORT" })
      )
    );
  }
  return registered;
}
