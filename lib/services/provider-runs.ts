import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { query, withTransaction } from "@/lib/db";
import {
  AI_STAGES,
  aiStageInputSchemas,
  selectProviders,
  type AIExecutionResult,
  type AIStage,
  type AIStageRequest,
  type ProviderStatus
} from "@/lib/providers";
import { AppError, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";

function providers() {
  const config = getConfig();
  return selectProviders({
    demoMode: config.demoMode,
    openAiApiKey: config.openAiApiKey,
    openAiModel: config.openAiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    timeoutMs: config.fetchTimeoutMs
  });
}

export function getProviderStatuses(): readonly ProviderStatus[] {
  return providers().statuses;
}

export function isAiStage(value: unknown): value is AIStage {
  return typeof value === "string" && (AI_STAGES as readonly string[]).includes(value);
}

export async function runPersistedAiStage<Stage extends AIStage>(input: {
  stage: Stage;
  projectId: string;
  promptTemplateVersion: string;
  stageInput: unknown;
  allowedSourceIds: readonly string[];
}): Promise<AIExecutionResult<Stage>> {
  const project = await query("SELECT id FROM research_projects WHERE id = $1", [
    input.projectId
  ]);
  if (!project.rowCount) {
    throw notFound("Project");
  }
  const allowed = await query<{ id: string }>(
    "SELECT id FROM sources WHERE project_id = $1 AND id = ANY($2::text[])",
    [input.projectId, [...input.allowedSourceIds]]
  );
  if (allowed.rows.length !== new Set(input.allowedSourceIds).size) {
    throw new AppError(
      400,
      "UNKNOWN_SOURCE_ID",
      "The AI request contains a source ID that does not belong to this project."
    );
  }

  const selection = providers();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const parsedStageInput = aiStageInputSchemas[input.stage].parse(input.stageInput);
  const request: AIStageRequest<Stage> = {
    stage: input.stage,
    projectId: input.projectId,
    promptTemplateVersion: input.promptTemplateVersion,
    input: parsedStageInput as AIStageRequest<Stage>["input"],
    allowedSourceIds: input.allowedSourceIds
  };
  await query(
    "INSERT INTO ai_runs (id, project_id, stage, provider, model, prompt_template_version, status, input_reference) VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', $7::jsonb)",
    [
      runId,
      input.projectId,
      input.stage,
      selection.ai.id,
      selection.ai.model,
      input.promptTemplateVersion,
      JSON.stringify({
        projectId: input.projectId,
        stage: input.stage,
        allowedSourceIds: input.allowedSourceIds,
        inputSnapshot: parsedStageInput,
        startedAt
      })
    ]
  );
  const result = await selection.ai.run(request);
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE ai_runs SET duration_ms = $2, usage = $3::jsonb, status = $4, input_reference = input_reference || $5::jsonb, output_reference = $6::jsonb, error_code = $7, completed_at = NOW() WHERE id = $1",
      [
        runId,
        result.metadata.durationMs,
        JSON.stringify(result.metadata.usage ?? {}),
        result.success
          ? "SUCCEEDED"
          : result.error.code === "UNKNOWN_SOURCE_ID"
            ? "REJECTED"
            : "FAILED",
        JSON.stringify({
          inputHash: result.metadata.inputHash,
          startedAt: result.metadata.startedAt
        }),
        JSON.stringify(
          result.success
            ? {
                output: result.output,
                provenance: {
                  provider: result.metadata.provider,
                  model: result.metadata.model,
                  promptTemplateVersion: result.metadata.promptTemplateVersion,
                  requestId: result.metadata.requestId ?? null
                }
              }
            : {
                errorMessage: result.error.message,
                provenance: {
                  provider: result.metadata.provider,
                  model: result.metadata.model,
                  promptTemplateVersion: result.metadata.promptTemplateVersion,
                  requestId: result.metadata.requestId ?? null
                }
              }
        ),
        result.success ? null : result.error.code
      ]
    );
    await writeAuditEvent(client, {
      projectId: input.projectId,
      actorType: "AI",
      actorLabel: selection.ai.id,
      action: result.success ? "AI_STAGE_SUCCEEDED" : "AI_STAGE_FAILED",
      resourceType: "ai_run",
      resourceId: runId,
      afterState: {
        stage: input.stage,
        provider: selection.ai.id,
        model: selection.ai.model,
        promptTemplateVersion: input.promptTemplateVersion,
        success: result.success
      }
    });
  });
  return result;
}

export async function getAiRuns(projectId: string): Promise<Record<string, unknown>[]> {
  const result = await query<Record<string, unknown>>(
    "SELECT * FROM ai_runs WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
  return result.rows;
}
