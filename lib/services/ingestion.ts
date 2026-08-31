import { z } from "zod";
import { getConfig } from "@/lib/config";
import { query } from "@/lib/db";
import {
  assessPromptInjection,
  externalHtmlToText,
  safeFetch,
  SafeFetchError
} from "@/lib/security";
import { addSource, addSources } from "@/lib/services/sources";
import {
  LOCAL_USER_AUDIT_ACTOR,
  type AuditActor
} from "@/lib/services/audit";
import { AppError } from "@/lib/services/errors";
import { submitSourceSearchJob } from "@/lib/services/source-search-jobs";

export async function searchAndRegisterSources(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR,
  requestIdempotencyKey?: string
): Promise<Record<string, unknown>> {
  return submitSourceSearchJob({
    projectId,
    rawInput,
    actor,
    requestIdempotencyKey
  });
}

export async function fetchAndRegisterSource(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
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
    }, actor);
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

export async function importSources(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>[]> {
  const input = z
    .object({
      format: z.enum(["json", "markdown"]),
      content: z.string().min(2).max(500_000)
    })
    .parse(rawInput);
  let sourceInputs: unknown[];
  if (input.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch (error) {
      throw new AppError(400, "INVALID_IMPORT_JSON", "Source import content is not valid JSON.", {
        cause: error instanceof Error ? error.name : "Invalid JSON"
      });
    }
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
  const normalizedSources = sourceInputs.map((source) => ({
    ...z.record(z.string(), z.unknown()).parse(source),
    ingestionMethod: "IMPORT"
  }));
  return addSources(projectId, normalizedSources, actor);
}
