import { z } from "zod";
import { enforceRateLimit, handleAuthenticatedRoute } from "@/lib/http";
import {
  getAiRuns,
  isAiStage,
  runPersistedAiStage
} from "@/lib/services/provider-runs";
import { AppError } from "@/lib/services/errors";

type Context = { params: Promise<{ projectId: string }> };

const runSchema = z.object({
  stage: z.string(),
  promptTemplateVersion: z.string().trim().min(1).max(100),
  input: z.unknown(),
  allowedSourceIds: z.array(z.string().trim().min(1)).max(200).default([])
});

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, () => getAiRuns(projectId));
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleAuthenticatedRoute(request, async () => {
    enforceRateLimit(request, "ai-pipeline", 10);
    const input = runSchema.parse(await request.json());
    if (!isAiStage(input.stage)) {
      throw new AppError(400, "INVALID_AI_STAGE", "The requested AI pipeline stage is unknown.");
    }
    return runPersistedAiStage({
      stage: input.stage,
      projectId,
      promptTemplateVersion: input.promptTemplateVersion,
      stageInput: input.input,
      allowedSourceIds: input.allowedSourceIds
    });
  });
}
