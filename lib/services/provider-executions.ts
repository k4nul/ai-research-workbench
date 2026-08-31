import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "@/lib/db";
import type { CostStatus } from "@/lib/budgets";
import type { ProviderErrorClass } from "@/lib/providers";

export type ProviderExecutionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "REJECTED";

function safeError(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value
    .replace(/(?:sk-|bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1_000);
}

export type StartProviderExecutionInput = {
  projectId?: string;
  runId?: string;
  runStageId?: string;
  jobId?: string;
  jobAttemptId?: string;
  provider: string;
  model?: string;
  operation: string;
  clientRequestId: string;
  promptTemplateVersion?: string;
  structuredSchemaVersion?: string;
  inputHash: string;
  retryCount: number;
};

export type FinishProviderExecutionInput = {
  id: string;
  status: ProviderExecutionStatus;
  requestId?: string;
  providerResponseId?: string;
  outputHash?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costStatus: CostStatus;
  estimatedCostUsd: number | null;
  errorClass?: ProviderErrorClass;
  sanitizedError?: string;
};

export async function startProviderExecutionInTransaction(
  client: PoolClient,
  input: StartProviderExecutionInput
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO provider_executions (
       id, project_id, run_id, run_stage_id, job_id, job_attempt_id,
       provider, model, operation, client_request_id, prompt_template_version,
       structured_schema_version, input_hash, status, retry_count
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'STARTED', $14
     )`,
    [
      id,
      input.projectId ?? null,
      input.runId ?? null,
      input.runStageId ?? null,
      input.jobId ?? null,
      input.jobAttemptId ?? null,
      input.provider,
      input.model ?? null,
      input.operation,
      input.clientRequestId,
      input.promptTemplateVersion ?? null,
      input.structuredSchemaVersion ?? null,
      input.inputHash,
      input.retryCount
    ]
  );
  return id;
}

export async function startProviderExecution(
  input: StartProviderExecutionInput
): Promise<string> {
  return withTransaction((client) =>
    startProviderExecutionInTransaction(client, input)
  );
}

export async function finishProviderExecutionInTransaction(
  client: PoolClient,
  input: FinishProviderExecutionInput
): Promise<{ duplicateOf?: string }> {
  const current = await client.query<{ provider: string; status: string }>(
    "SELECT provider, status FROM provider_executions WHERE id = $1 FOR UPDATE",
    [input.id]
  );
  const row = current.rows[0];
  if (!row) {
    throw new Error("Provider execution was not found");
  }
  if (row.status !== "STARTED") {
    throw new Error("Provider execution is already terminal");
  }
  if (input.providerResponseId) {
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM provider_executions
         WHERE provider = $1 AND provider_response_id = $2 AND id <> $3
         LIMIT 1`,
      [row.provider, input.providerResponseId, input.id]
    );
    if (duplicate.rows[0]) {
      await client.query(
        `UPDATE provider_executions
           SET status = 'REJECTED', request_id = $2,
               error_class = 'NON_RETRYABLE_VALIDATION',
               sanitized_error = 'Duplicate provider response ID',
               completed_at = NOW(),
               latency_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000))::INTEGER,
               updated_at = NOW()
           WHERE id = $1`,
        [input.id, input.requestId ?? null]
      );
      return { duplicateOf: duplicate.rows[0].id };
    }
  }
  await client.query(
    `UPDATE provider_executions
       SET status = $2, request_id = $3, provider_response_id = $4,
           output_hash = $5, input_tokens = $6, output_tokens = $7, total_tokens = $8,
           cost_status = $9, estimated_cost = $10, error_class = $11,
           sanitized_error = $12, completed_at = NOW(),
           latency_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000))::INTEGER,
           updated_at = NOW()
       WHERE id = $1`,
    [
      input.id,
      input.status,
      input.requestId ?? null,
      input.providerResponseId ?? null,
      input.outputHash ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      input.costStatus,
      input.estimatedCostUsd,
      input.errorClass ?? null,
      safeError(input.sanitizedError)
    ]
  );
  return {};
}

export async function finishProviderExecution(
  input: FinishProviderExecutionInput
): Promise<{ duplicateOf?: string }> {
  return withTransaction((client) =>
    finishProviderExecutionInTransaction(client, input)
  );
}
