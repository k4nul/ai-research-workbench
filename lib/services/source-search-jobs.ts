import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { withTransaction } from "@/lib/db";
import { assessSourceFreshness } from "@/lib/domain/research";
import type { JobErrorClass } from "@/lib/domain/jobs";
import {
  canTransitionResearchRun,
  type ResearchRunStatus
} from "@/lib/domain/research-runs";
import {
  selectProviders,
  type SearchHit,
  type SearchQuery,
  type SearchResponse
} from "@/lib/providers";
import { inputHash } from "@/lib/providers/ai-shared";
import { validateExternalUrl } from "@/lib/security";
import {
  writeAuditEvent,
  type AuditActor
} from "@/lib/services/audit";
import { conflict, notFound } from "@/lib/services/errors";
import {
  submitJobInTransaction,
  type JobRow
} from "@/lib/services/jobs";
import {
  finishProviderExecutionInTransaction,
  startProviderExecutionInTransaction
} from "@/lib/services/provider-executions";
import { invalidateDownstreamReview } from "@/lib/services/review-state";
import { sourceInputSchema, type SourceInput } from "@/lib/validation";

export const SOURCE_SEARCH_JOB = "SOURCE_SEARCH";

const safeIdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Use letters, numbers, dots, underscores, colons, or hyphens."
  );

export const sourceSearchRequestSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((value) => value.split(/\s+/).length <= 50, {
      message: "Search queries may contain at most 50 words."
    }),
  count: z.coerce.number().int().min(1).max(20).default(5),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  searchLanguage: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,8}$/)
    .transform((value) => value.toLowerCase())
    .optional(),
  uiLanguage: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}-[A-Za-z]{2}$/)
    .optional(),
  safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
  freshness: z.enum(["pd", "pw", "pm", "py"]).optional(),
  runId: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: safeIdempotencyKey.optional()
});

const sourceSearchJobPayloadSchema = z.object({
  projectId: z.string().trim().min(1).max(500),
  runId: z.string().trim().min(1).max(500).optional(),
  providerId: z.string().trim().min(1).max(200),
  request: z
    .object({
      query: z.string().trim().min(1).max(400),
      count: z.number().int().min(1).max(20),
      country: z.string().trim().length(2).optional(),
      searchLanguage: z.string().trim().min(2).max(8).optional(),
      uiLanguage: z.string().trim().min(5).max(6).optional(),
      safeSearch: z.enum(["off", "moderate", "strict"]),
      freshness: z.enum(["pd", "pw", "pm", "py"]).optional()
    })
    .strict(),
  actor: z
    .object({
      actorType: z.enum(["USER", "AI", "SYSTEM"]),
      actorLabel: z.string().trim().min(1).max(500)
    })
    .strict()
}).strict();

const sourceSearchOutputSchema = z
  .object({
    search: z
      .object({
        provider: z.string().trim().min(1).max(200),
        query: z.string().trim().min(1).max(400),
        results: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(200),
                title: z.string().trim().min(1).max(500),
                url: z.string().url(),
                snippet: z.string().max(20_000),
                publishedAt: z.string().optional(),
                language: z.string().trim().min(2).max(20).optional()
              })
              .passthrough()
          )
          .max(20),
        metadata: z
          .object({
            startedAt: z.string(),
            durationMs: z.number().nonnegative(),
            requestId: z.string().optional(),
            rateLimit: z.record(z.string(), z.unknown()).optional()
          })
          .passthrough()
      })
      .passthrough(),
    registered: z.array(z.record(z.string(), z.unknown())).max(20)
  })
  .strict();

export type SourceSearchJobPayload = z.infer<typeof sourceSearchJobPayloadSchema>;
export type SourceSearchOutput = z.infer<typeof sourceSearchOutputSchema>;

type SourceRow = QueryResultRow & {
  id: string;
  project_id: string;
  url: string | null;
  title: string;
  ingestion_method: string;
};

type SearchRunRow = QueryResultRow & {
  id: string;
  project_id: string;
  status: ResearchRunStatus;
  search_config_snapshot: Record<string, unknown>;
  budget_snapshot: Record<string, unknown>;
  total_search_requests: number;
};

type FencedJobRow = JobRow & { lease_current: boolean };

export class SourceSearchJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errorClass: JobErrorClass
  ) {
    super(message);
    this.name = "SourceSearchJobError";
  }
}

export type SourceSearchSubmission = {
  search: SearchResponse | null;
  registered: readonly Record<string, unknown>[];
  job: {
    id: string;
    jobType: string;
    status: JobRow["status"];
    runId: string | null;
  };
  created: boolean;
  queued: boolean;
};

export type ReservedSourceSearchAttempt = {
  executionId: string;
  payload: SourceSearchJobPayload;
  clientRequestId: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshotText(
  snapshot: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function budgetLimit(
  snapshot: Record<string, unknown>,
  key: "maxSearchRequests" | "maxSources"
): number {
  const value = snapshot[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SourceSearchJobError(
      "INVALID_RUN_BUDGET",
      `The frozen run budget has no valid ${key} limit.`,
      "NON_RETRYABLE_VALIDATION"
    );
  }
  return Number(value);
}

function searchQuery(
  input: z.infer<typeof sourceSearchRequestSchema>
): SourceSearchJobPayload["request"] {
  return {
    query: input.query,
    count: input.count,
    ...(input.country ? { country: input.country } : {}),
    ...(input.searchLanguage ? { searchLanguage: input.searchLanguage } : {}),
    ...(input.uiLanguage ? { uiLanguage: input.uiLanguage } : {}),
    safeSearch: input.safeSearch,
    ...(input.freshness ? { freshness: input.freshness } : {})
  };
}

function publicSubmission(
  job: JobRow,
  created: boolean
): SourceSearchSubmission {
  const stored = record(job.output_reference);
  const search = stored.search;
  const registered = stored.registered;
  return {
    search:
      job.status === "SUCCEEDED" && search && typeof search === "object"
        ? (search as SearchResponse)
        : null,
    registered:
      job.status === "SUCCEEDED" && Array.isArray(registered)
        ? (registered as Record<string, unknown>[])
        : [],
    job: {
      id: job.id,
      jobType: job.job_type,
      status: job.status,
      runId: job.run_id
    },
    created,
    queued: ["QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT"].includes(job.status)
  };
}

function currentSearchProviderId(): string {
  const config = getConfig();
  return selectProviders({
    demoMode: config.demoMode,
    openAiApiKey: config.openAiApiKey,
    openAiModel: config.openAiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    timeoutMs: config.fetchTimeoutMs
  }).search.id;
}

export async function submitSourceSearchJob(input: {
  projectId: string;
  rawInput: unknown;
  actor: AuditActor;
  requestIdempotencyKey?: string;
}): Promise<SourceSearchSubmission> {
  const parsed = sourceSearchRequestSchema.parse(input.rawInput);
  const headerKey = input.requestIdempotencyKey
    ? safeIdempotencyKey.parse(input.requestIdempotencyKey)
    : undefined;
  if (
    headerKey &&
    parsed.idempotencyKey &&
    headerKey !== parsed.idempotencyKey
  ) {
    throw conflict(
      "IDEMPOTENCY_KEY_MISMATCH",
      "The body and header idempotency keys must match."
    );
  }
  const request = searchQuery(parsed);
  const fallbackProviderId = currentSearchProviderId();
  return withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [input.projectId]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
    let run: SearchRunRow | undefined;
    if (parsed.runId) {
      const result = await client.query<SearchRunRow>(
        "SELECT id, project_id, status, search_config_snapshot, budget_snapshot, total_search_requests FROM research_runs WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [parsed.runId, input.projectId]
      );
      run = result.rows[0];
      if (!run) {
        throw notFound("Research run");
      }
      if (["CANCELLING", "CANCELLED", "FAILED", "COMPLETED"].includes(run.status)) {
        throw conflict(
          "RUN_NOT_SEARCHABLE",
          "Search work cannot be added to a terminal or cancelling research run."
        );
      }
    }
    const providerId = run
      ? snapshotText(
          run.search_config_snapshot,
          "searchProvider",
          "provider",
          "search"
        ) ?? fallbackProviderId
      : fallbackProviderId;
    const payload: SourceSearchJobPayload = {
      projectId: input.projectId,
      ...(run ? { runId: run.id } : {}),
      providerId,
      request,
      actor: {
        actorType: input.actor.actorType,
        actorLabel: input.actor.actorLabel
      }
    };
    const callerKey =
      headerKey ??
      parsed.idempotencyKey ??
      `auto-${inputHash({
        projectId: input.projectId,
        runId: run?.id,
        providerId,
        request
      }).slice(0, 40)}`;
    const config = getConfig();
    const submitted = await submitJobInTransaction(client, {
      projectId: input.projectId,
      runId: run?.id,
      jobType: SOURCE_SEARCH_JOB,
      inputReference: payload,
      idempotencyKey: `source-search:${run?.id ?? "project"}:${callerKey}`,
      priority: 15,
      maxAttempts: config.jobMaxAttempts,
      timeoutMs: Math.max(config.jobDefaultTimeoutMs, config.fetchTimeoutMs + 5_000)
    });
    if (submitted.created) {
      await writeAuditEvent(client, {
        projectId: input.projectId,
        ...input.actor,
        action: "SOURCE_SEARCH_QUEUED",
        resourceType: "job",
        resourceId: submitted.job.id,
        afterState: {
          runId: run?.id,
          provider: providerId,
          queryHash: inputHash(request),
          count: request.count
        }
      });
    }
    return publicSubmission(submitted.job, submitted.created);
  });
}

export function parseSourceSearchJob(job: JobRow): SourceSearchJobPayload {
  if (job.job_type !== SOURCE_SEARCH_JOB) {
    throw new SourceSearchJobError(
      "INVALID_SEARCH_JOB",
      "The job is not a source-search job.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  const payload = sourceSearchJobPayloadSchema.parse(job.input_reference);
  if (
    job.project_id !== payload.projectId ||
    job.run_id !== (payload.runId ?? null)
  ) {
    throw new SourceSearchJobError(
      "SEARCH_JOB_LINK_MISMATCH",
      "The source-search payload does not match its durable job linkage.",
      "NON_RETRYABLE_SECURITY"
    );
  }
  return payload;
}

async function lockFencedSearchJob(
  client: PoolClient,
  job: JobRow,
  workerId: string
): Promise<FencedJobRow> {
  const locked = await client.query<FencedJobRow>(
    "SELECT j.*, (j.lease_expires_at > NOW()) AS lease_current FROM jobs j WHERE j.id = $1 FOR UPDATE",
    [job.id]
  );
  const current = locked.rows[0];
  if (
    !current ||
    current.project_id !== job.project_id ||
    current.job_type !== SOURCE_SEARCH_JOB ||
    current.status !== "RUNNING" ||
    current.lease_owner !== workerId ||
    current.attempts !== job.attempts ||
    !current.lease_current
  ) {
    throw new SourceSearchJobError(
      "JOB_LEASE_LOST",
      "The worker no longer owns the current source-search attempt.",
      "UNKNOWN"
    );
  }
  return current;
}

async function lockSearchProject(
  client: PoolClient,
  projectId: string
): Promise<{ research_date: string; source_max_age_days: number }> {
  const project = await client.query<{
    research_date: string;
    source_max_age_days: number;
  }>(
    "SELECT research_date::text, source_max_age_days FROM research_projects WHERE id = $1 FOR UPDATE",
    [projectId]
  );
  if (!project.rows[0]) {
    throw new SourceSearchJobError(
      "PROJECT_DELETED",
      "The project was deleted before source search completed.",
      "CANCELLED"
    );
  }
  return project.rows[0];
}

async function lockSearchRun(
  client: PoolClient,
  payload: SourceSearchJobPayload
): Promise<SearchRunRow | undefined> {
  if (!payload.runId) {
    return undefined;
  }
  const run = await client.query<SearchRunRow>(
    "SELECT id, project_id, status, search_config_snapshot, budget_snapshot, total_search_requests FROM research_runs WHERE id = $1 AND project_id = $2 FOR UPDATE",
    [payload.runId, payload.projectId]
  );
  const row = run.rows[0];
  if (!row) {
    throw new SourceSearchJobError(
      "SEARCH_RUN_DELETED",
      "The linked research run no longer exists.",
      "CANCELLED"
    );
  }
  if (["CANCELLING", "CANCELLED"].includes(row.status)) {
    throw new SourceSearchJobError(
      "SEARCH_RUN_CANCELLED",
      "The linked research run is cancelling or cancelled.",
      "CANCELLED"
    );
  }
  if (["FAILED", "COMPLETED"].includes(row.status)) {
    throw new SourceSearchJobError(
      "SEARCH_RUN_TERMINAL",
      "The linked research run is already terminal.",
      "NON_RETRYABLE_USER_INPUT"
    );
  }
  return row;
}

async function projectSourceCount(
  client: PoolClient,
  projectId: string
): Promise<number> {
  const result = await client.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM sources WHERE project_id = $1",
    [projectId]
  );
  return result.rows[0]?.count ?? 0;
}

async function blockRunForSearchBudget(
  client: PoolClient,
  run: SearchRunRow,
  input: {
    projectId: string;
    jobId: string;
    violations: readonly string[];
  }
): Promise<void> {
  const reason = `Source search budget exceeded: ${input.violations.join(", ")}.`;
  if (run.status !== "BLOCKED" && canTransitionResearchRun(run.status, "BLOCKED")) {
    await client.query(
      "UPDATE research_runs SET status = 'BLOCKED', block_reason = $2, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [run.id, reason]
    );
  }
  await writeAuditEvent(client, {
    projectId: input.projectId,
    actorType: "SYSTEM",
    actorLabel: "Durable source search worker",
    action: "SOURCE_SEARCH_BUDGET_BLOCKED",
    resourceType: "research_run",
    resourceId: run.id,
    beforeState: { status: run.status },
    afterState: {
      status:
        run.status === "BLOCKED" || canTransitionResearchRun(run.status, "BLOCKED")
          ? "BLOCKED"
          : run.status,
      jobId: input.jobId,
      violations: input.violations,
      reason
    }
  });
}

export async function reserveSourceSearchAttempt(input: {
  job: JobRow;
  workerId: string;
}): Promise<ReservedSourceSearchAttempt> {
  const payload = parseSourceSearchJob(input.job);
  const outcome = await withTransaction<
    ReservedSourceSearchAttempt | SourceSearchJobError
  >(async (client) => {
    await lockSearchProject(client, payload.projectId);
    const job = await lockFencedSearchJob(client, input.job, input.workerId);
    const run = await lockSearchRun(client, payload);
    if (run) {
      const sourceCount = await projectSourceCount(client, payload.projectId);
      const violations: string[] = [];
      if (
        run.total_search_requests + 1 >
        budgetLimit(run.budget_snapshot, "maxSearchRequests")
      ) {
        violations.push("MAX_SEARCH_REQUESTS");
      }
      if (
        sourceCount + payload.request.count >
        budgetLimit(run.budget_snapshot, "maxSources")
      ) {
        violations.push("MAX_SOURCES");
      }
      if (violations.length > 0) {
        await blockRunForSearchBudget(client, run, {
          projectId: payload.projectId,
          jobId: job.id,
          violations
        });
        return new SourceSearchJobError(
          "SEARCH_BUDGET_EXCEEDED",
          `Run budget prevents source search: ${violations.join(", ")}.`,
          "NON_RETRYABLE_BUDGET"
        );
      }
    }
    const attempt = await client.query<{ id: string }>(
      "SELECT id FROM job_attempts WHERE job_id = $1 AND attempt_number = $2 AND status = 'RUNNING'",
      [job.id, job.attempts]
    );
    if (!attempt.rows[0]) {
      throw new SourceSearchJobError(
        "SEARCH_ATTEMPT_NOT_RUNNING",
        "The source-search job attempt is not running.",
        "UNKNOWN"
      );
    }
    const clientRequestId = `${job.id}:${job.attempts}`;
    const executionId = await startProviderExecutionInTransaction(client, {
      projectId: payload.projectId,
      runId: payload.runId,
      jobId: job.id,
      jobAttemptId: attempt.rows[0].id,
      provider: payload.providerId,
      operation: "search.web",
      clientRequestId,
      inputHash: inputHash(payload.request),
      retryCount: Math.max(0, job.attempts - 1)
    });
    if (run) {
      await client.query(
        "UPDATE research_runs SET total_search_requests = total_search_requests + 1, updated_at = NOW(), version = version + 1 WHERE id = $1",
        [run.id]
      );
    }
    return { executionId, payload, clientRequestId };
  });
  if (outcome instanceof SourceSearchJobError) {
    throw outcome;
  }
  return outcome;
}

export async function reuseCommittedSourceSearchResults(input: {
  job: JobRow;
  workerId: string;
}): Promise<SourceSearchOutput | null> {
  if (input.job.output_reference === null) {
    return null;
  }
  const payload = parseSourceSearchJob(input.job);
  return withTransaction(async (client) => {
    await lockSearchProject(client, payload.projectId);
    const current = await lockFencedSearchJob(client, input.job, input.workerId);
    const parsed = sourceSearchOutputSchema.safeParse(current.output_reference);
    if (
      !parsed.success ||
      !current.output_hash ||
      inputHash(parsed.data) !== current.output_hash ||
      parsed.data.search.provider !== payload.providerId ||
      parsed.data.search.query !== payload.request.query
    ) {
      throw new SourceSearchJobError(
        "INVALID_SEARCH_CHECKPOINT",
        "The committed source-search checkpoint failed integrity validation.",
        "NON_RETRYABLE_SECURITY"
      );
    }
    const resultIds = parsed.data.search.results.map((result) => result.id);
    const registeredIds = parsed.data.registered.map((source) => source.id);
    if (
      registeredIds.some((id) => typeof id !== "string") ||
      new Set(resultIds).size !== resultIds.length ||
      new Set(registeredIds).size !== registeredIds.length ||
      resultIds.length !== registeredIds.length ||
      resultIds.some((id) => !registeredIds.includes(id))
    ) {
      throw new SourceSearchJobError(
        "INVALID_SEARCH_CHECKPOINT",
        "The committed source-search checkpoint has inconsistent source IDs.",
        "NON_RETRYABLE_SECURITY"
      );
    }
    if (resultIds.length > 0) {
      const sources = await client.query<{ id: string }>(
        "SELECT id FROM sources WHERE project_id = $1 AND id = ANY($2::text[])",
        [payload.projectId, resultIds]
      );
      if (sources.rowCount !== resultIds.length) {
        throw new SourceSearchJobError(
          "SEARCH_CHECKPOINT_SOURCE_MISSING",
          "A source referenced by the committed search checkpoint is missing.",
          "NON_RETRYABLE_SECURITY"
        );
      }
    }
    const provenance = await client.query(
      "SELECT id FROM provider_executions WHERE job_id = $1 AND status = 'SUCCEEDED' LIMIT 1",
      [current.id]
    );
    if (!provenance.rowCount) {
      throw new SourceSearchJobError(
        "SEARCH_CHECKPOINT_PROVENANCE_MISSING",
        "The committed search checkpoint has no successful provider provenance.",
        "NON_RETRYABLE_SECURITY"
      );
    }
    return parsed.data;
  });
}

function deterministicSourceId(
  projectId: string,
  providerId: string,
  url: string
): string {
  const digest = createHash("sha256")
    .update(`source-search-v1\0${projectId}\0${providerId}\0${url}`)
    .digest("hex");
  return `search-${digest.slice(0, 48)}`;
}

function publishedDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match?.[0];
}

function sourceFromHit(
  projectId: string,
  providerId: string,
  hit: SearchHit,
  request: SearchQuery
): { id: string; providerResultId: string; source: SourceInput } {
  const normalizedUrl = validateExternalUrl(hit.url);
  normalizedUrl.hash = "";
  const url = normalizedUrl.toString();
  const source = sourceInputSchema.parse({
    url,
    title: hit.title,
    publisher: new URL(url).hostname,
    publishedAt: publishedDate(hit.publishedAt),
    sourceType: "SEARCH_RESULT",
    language: hit.language ?? request.searchLanguage ?? "en",
    reliabilityGrade: "UNRATED",
    contentSummary: hit.snippet || undefined,
    ingestionMethod: "SEARCH",
    mimeType: "text/html"
  });
  return {
    id: deterministicSourceId(projectId, providerId, url),
    providerResultId: hit.id,
    source
  };
}

export async function commitSourceSearchResults(input: {
  job: JobRow;
  workerId: string;
  executionId: string;
  response: SearchResponse;
  signal?: AbortSignal;
}): Promise<{ search: SearchResponse; registered: Record<string, unknown>[] }> {
  const payload = parseSourceSearchJob(input.job);
  if (input.response.provider !== payload.providerId) {
    throw new SourceSearchJobError(
      "SEARCH_PROVIDER_MISMATCH",
      "The search response came from a provider other than the frozen provider.",
      "NON_RETRYABLE_SECURITY"
    );
  }
  if (input.response.query.trim() !== payload.request.query) {
    throw new SourceSearchJobError(
      "SEARCH_QUERY_MISMATCH",
      "The search response does not match the frozen query.",
      "NON_RETRYABLE_SECURITY"
    );
  }
  if (input.response.results.length > payload.request.count) {
    throw new SourceSearchJobError(
      "SEARCH_RESULT_LIMIT_EXCEEDED",
      "The provider returned more results than the bounded search requested.",
      "NON_RETRYABLE_VALIDATION"
    );
  }
  const unique = new Map<
    string,
    ReturnType<typeof sourceFromHit> & { hit: SearchHit }
  >();
  for (const hit of input.response.results) {
    const normalized = sourceFromHit(
      payload.projectId,
      payload.providerId,
      hit,
      payload.request
    );
    if (!unique.has(normalized.id)) {
      unique.set(normalized.id, { ...normalized, hit });
    }
  }
  const outcome = await withTransaction<
    | { search: SearchResponse; registered: Record<string, unknown>[] }
    | SourceSearchJobError
  >(async (client) => {
    if (input.signal?.aborted) {
      throw new SourceSearchJobError(
        "SEARCH_ABORTED",
        "Source search was aborted before results could be committed.",
        "CANCELLED"
      );
    }
    const project = await lockSearchProject(client, payload.projectId);
    await lockFencedSearchJob(client, input.job, input.workerId);
    const run = await lockSearchRun(client, payload);
    const ids = [...unique.keys()];
    const existing = ids.length
      ? await client.query<SourceRow>(
          "SELECT * FROM sources WHERE id = ANY($1::text[]) FOR UPDATE",
          [ids]
        )
      : { rows: [] as SourceRow[] };
    const existingById = new Map(existing.rows.map((row) => [row.id, row]));
    const newCount = ids.filter((id) => !existingById.has(id)).length;
    if (run) {
      const currentCount = await projectSourceCount(client, payload.projectId);
      if (
        currentCount + newCount >
        budgetLimit(run.budget_snapshot, "maxSources")
      ) {
        await blockRunForSearchBudget(client, run, {
          projectId: payload.projectId,
          jobId: input.job.id,
          violations: ["MAX_SOURCES"]
        });
        return new SourceSearchJobError(
          "SEARCH_SOURCE_BUDGET_EXCEEDED",
          "Run source budget changed before the search results could be committed.",
          "NON_RETRYABLE_BUDGET"
        );
      }
    }
    const registered: Record<string, unknown>[] = [];
    let insertedCount = 0;
    for (const candidate of unique.values()) {
      if (input.signal?.aborted) {
        throw new SourceSearchJobError(
          "SEARCH_ABORTED",
          "Source search was aborted while results were being committed.",
          "CANCELLED"
        );
      }
      const prior = existingById.get(candidate.id);
      if (
        prior &&
        (prior.project_id !== payload.projectId ||
          prior.url !== candidate.source.url ||
          prior.ingestion_method !== "SEARCH")
      ) {
        throw new SourceSearchJobError(
          "SEARCH_SOURCE_ID_COLLISION",
          "A deterministic source ID was already used for different source data.",
          "NON_RETRYABLE_SECURITY"
        );
      }
      if (prior) {
        registered.push(prior);
        continue;
      }
      const freshness = assessSourceFreshness({
        publishedAt: candidate.source.publishedAt,
        researchDate: project.research_date,
        maxAgeDays: project.source_max_age_days
      });
      const inserted = await client.query<SourceRow>(
        `INSERT INTO sources (
           id, project_id, url, title, publisher, published_at, source_type,
           language, reliability_grade, freshness_status, ingestion_method,
           mime_type, content_summary
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SEARCH', $11, $12
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          candidate.id,
          payload.projectId,
          candidate.source.url,
          candidate.source.title,
          candidate.source.publisher ?? null,
          candidate.source.publishedAt ?? null,
          candidate.source.sourceType,
          candidate.source.language,
          candidate.source.reliabilityGrade,
          freshness,
          candidate.source.mimeType ?? null,
          candidate.source.contentSummary ?? null
        ]
      );
      let row = inserted.rows[0];
      if (!row) {
        const conflicted = await client.query<SourceRow>(
          "SELECT * FROM sources WHERE id = $1 FOR UPDATE",
          [candidate.id]
        );
        row = conflicted.rows[0];
        if (
          !row ||
          row.project_id !== payload.projectId ||
          row.url !== candidate.source.url ||
          row.ingestion_method !== "SEARCH"
        ) {
          throw new SourceSearchJobError(
            "SEARCH_SOURCE_ID_COLLISION",
            "A deterministic source ID was concurrently used for different source data.",
            "NON_RETRYABLE_SECURITY"
          );
        }
      } else {
        insertedCount += 1;
        await writeAuditEvent(client, {
          projectId: payload.projectId,
          ...payload.actor,
          action: "SOURCE_ADDED",
          resourceType: "source",
          resourceId: candidate.id,
          afterState: {
            ingestionMethod: "SEARCH",
            provider: payload.providerId,
            providerResultId: candidate.providerResultId,
            requestId: input.response.metadata.requestId,
            jobId: input.job.id,
            queryHash: inputHash(payload.request),
            freshness
          }
        });
      }
      registered.push(row);
    }
    if (insertedCount > 0) {
      await invalidateDownstreamReview(client, payload.projectId, "RESEARCHING");
    }
    if (input.signal?.aborted) {
      throw new SourceSearchJobError(
        "SEARCH_ABORTED",
        "Source search was aborted before provenance could be committed.",
        "CANCELLED"
      );
    }
    const search: SearchResponse = {
      ...input.response,
      results: [...unique.values()].map((candidate) => ({
        ...candidate.hit,
        id: candidate.id,
        providerResultId: candidate.providerResultId
      }))
    };
    await finishProviderExecutionInTransaction(client, {
      id: input.executionId,
      status: "SUCCEEDED",
      requestId: input.response.metadata.requestId,
      outputHash: inputHash(search),
      costStatus: payload.providerId === "mock-search" ? "KNOWN" : "UNKNOWN",
      estimatedCostUsd: payload.providerId === "mock-search" ? 0 : null
    });
    await writeAuditEvent(client, {
      projectId: payload.projectId,
      actorType: "SYSTEM",
      actorLabel: "Durable source search worker",
      action: "SOURCE_SEARCH_COMPLETED",
      resourceType: "job",
      resourceId: input.job.id,
      afterState: {
        runId: payload.runId,
        provider: payload.providerId,
        resultCount: search.results.length,
        insertedSourceCount: insertedCount,
        providerExecutionId: input.executionId
      }
    });
    const checkpoint = sourceSearchOutputSchema.parse(
      JSON.parse(JSON.stringify({ search, registered }))
    );
    await client.query(
      "UPDATE jobs SET output_reference = $2::jsonb, output_hash = $3, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [input.job.id, JSON.stringify(checkpoint), inputHash(checkpoint)]
    );
    if (input.signal?.aborted) {
      throw new SourceSearchJobError(
        "SEARCH_ABORTED",
        "Source search was aborted before its transaction completed.",
        "CANCELLED"
      );
    }
    return checkpoint;
  });
  if (outcome instanceof SourceSearchJobError) {
    throw outcome;
  }
  return outcome;
}
