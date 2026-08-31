import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db";
import {
  evidenceInputSchema,
  sourceInputSchema,
  type SourceInput
} from "@/lib/validation";
import {
  LOCAL_USER_AUDIT_ACTOR,
  writeAuditEvent,
  type AuditActor
} from "@/lib/services/audit";
import { notFound } from "@/lib/services/errors";
import { invalidateDownstreamReview } from "@/lib/services/review-state";
import { assessSourceFreshness } from "@/lib/domain/research";
import {
  assessPromptInjection,
  externalHtmlToText,
  sanitizeExternalHtml
} from "@/lib/security/content";

type LockedSourceProject = {
  research_date: string;
  source_max_age_days: number;
};

async function insertSource(
  client: PoolClient,
  projectId: string,
  project: LockedSourceProject,
  input: SourceInput,
  actor: AuditActor
): Promise<Record<string, unknown>> {
  if (input.reusedFromSourceId) {
    const reusable = await client.query(
      "SELECT id FROM sources WHERE id = $1",
      [input.reusedFromSourceId]
    );
    if (!reusable.rowCount) {
      throw notFound("Reusable source");
    }
  }
  const id = randomUUID();
  const contentLooksLikeHtml =
    input.sanitizedContent !== undefined &&
    (input.mimeType?.toLowerCase().includes("html") === true ||
      /<!doctype\s+html|<\/?[a-z][^>]*>/i.test(input.sanitizedContent));
  const sanitizedContent =
    input.sanitizedContent && contentLooksLikeHtml
      ? externalHtmlToText(sanitizeExternalHtml(input.sanitizedContent))
      : input.sanitizedContent;
  const injection = assessPromptInjection(sanitizedContent ?? "");
  const contentHash = sanitizedContent
    ? createHash("sha256").update(sanitizedContent).digest("hex")
    : null;
  const duplicate = contentHash
    ? await client.query<{ id: string }>(
        "SELECT id FROM sources WHERE project_id = $1 AND content_hash = $2 LIMIT 1",
        [projectId, contentHash]
      )
    : { rows: [] };
  const freshness = assessSourceFreshness({
    publishedAt: input.publishedAt,
    researchDate: project.research_date,
    maxAgeDays: project.source_max_age_days
  });
  const result = await client.query(
    "INSERT INTO sources (id, project_id, reused_from_source_id, url, title, publisher, author, published_at, source_type, language, reliability_grade, freshness_status, duplicate_of_source_id, content_hash, usage_restrictions, ingestion_method, mime_type, content_summary, sanitized_content, prompt_injection_flag) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *",
    [
      id,
      projectId,
      input.reusedFromSourceId ?? null,
      input.url ?? null,
      input.title,
      input.publisher ?? null,
      input.author ?? null,
      input.publishedAt ?? null,
      input.sourceType,
      input.language,
      input.reliabilityGrade,
      freshness,
      duplicate.rows[0]?.id ?? null,
      contentHash,
      input.usageRestrictions ?? null,
      input.ingestionMethod,
      input.mimeType ?? null,
      input.contentSummary ?? null,
      sanitizedContent ?? null,
      injection.flagged
    ]
  );
  await writeAuditEvent(client, {
    projectId,
    ...actor,
    action: "SOURCE_ADDED",
    resourceType: "source",
    resourceId: id,
    afterState: {
      title: input.title,
      ingestionMethod: input.ingestionMethod,
      duplicateOf: duplicate.rows[0]?.id,
      freshness,
      promptInjectionFlag: injection.flagged,
      promptInjectionIndicators: injection.indicators
    }
  });
  return result.rows[0];
}

export async function addSources(
  projectId: string,
  rawInputs: readonly unknown[],
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>[]> {
  const inputs = sourceInputSchema.array().min(1).max(100).parse(rawInputs);
  return withTransaction(async (client) => {
    const project = await client.query<LockedSourceProject>(
      "SELECT research_date::text, source_max_age_days FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rows[0]) {
      throw notFound("Project");
    }
    const results: Record<string, unknown>[] = [];
    for (const input of inputs) {
      results.push(
        await insertSource(client, projectId, project.rows[0], input, actor)
      );
    }
    if (results.length > 0) {
      await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    }
    return results;
  });
}

export async function addSource(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  const [source] = await addSources(projectId, [rawInput], actor);
  if (!source) {
    throw new Error("A single-source insert returned no source.");
  }
  return source;
}

export async function addEvidence(
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  const input = evidenceInputSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const source = await client.query<{ project_id: string }>(
      "SELECT project_id FROM sources WHERE id = $1",
      [input.sourceId]
    );
    if (!source.rows[0]) {
      throw notFound("Source");
    }
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO evidence (id, source_id, summary, minimal_quote, original_location, page_or_section, confidence, verification_status, support_extent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
      [
        id,
        input.sourceId,
        input.summary,
        input.minimalQuote ?? null,
        input.originalLocation ?? null,
        input.pageOrSection ?? null,
        input.confidence,
        input.verificationStatus,
        input.supportExtent
      ]
    );
    await invalidateDownstreamReview(
      client,
      source.rows[0].project_id,
      "RESEARCHING"
    );
    await writeAuditEvent(client, {
      projectId: source.rows[0].project_id,
      ...actor,
      action: "EVIDENCE_EXTRACTED",
      resourceType: "evidence",
      resourceId: id,
      afterState: {
        sourceId: input.sourceId,
        verificationStatus: input.verificationStatus
      }
    });
    return result.rows[0];
  });
}

export async function getSource(sourceId: string): Promise<Record<string, unknown>> {
  const [source, evidence, claims] = await Promise.all([
    query("SELECT * FROM sources WHERE id = $1", [sourceId]),
    query("SELECT * FROM evidence WHERE source_id = $1 AND is_current = TRUE ORDER BY created_at", [sourceId]),
    query(
      "SELECT c.*, ce.relationship, ce.evidence_id FROM claims c JOIN claim_evidence ce ON ce.claim_id = c.id JOIN evidence e ON e.id = ce.evidence_id WHERE e.source_id = $1 AND c.is_current = TRUE AND e.is_current = TRUE ORDER BY c.created_at",
      [sourceId]
    )
  ]);
  if (!source.rows[0]) {
    throw notFound("Source");
  }
  return { source: source.rows[0], evidence: evidence.rows, claims: claims.rows };
}

export async function reuseSource(
  projectId: string,
  sourceId: string,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  const source = await query<Record<string, unknown> & SourceInput>(
    "SELECT * FROM sources WHERE id = $1",
    [sourceId]
  );
  const row = source.rows[0];
  if (!row) {
    throw notFound("Source");
  }
  return addSource(projectId, {
    url: row.url || undefined,
    title: row.title,
    publisher: row.publisher || undefined,
    author: row.author || undefined,
    publishedAt:
      typeof row.published_at === "string"
        ? row.published_at.slice(0, 10)
        : undefined,
    sourceType: row.source_type,
    language: row.language,
    reliabilityGrade: row.reliability_grade,
    usageRestrictions: row.usage_restrictions || undefined,
    contentSummary: row.content_summary || undefined,
    sanitizedContent: row.sanitized_content || undefined,
    ingestionMethod: "REUSE",
    mimeType: row.mime_type || undefined,
    reusedFromSourceId: sourceId
  }, actor);
}
