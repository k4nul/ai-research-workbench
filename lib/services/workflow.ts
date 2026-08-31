import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import {
  researchPlanSchema,
  researchQuestionSchema
} from "@/lib/validation";
import {
  CONFIGURED_PROVIDER_AUDIT_ACTOR,
  LOCAL_USER_AUDIT_ACTOR,
  writeAuditEvent,
  type AuditActor
} from "@/lib/services/audit";
import { AppError, notFound } from "@/lib/services/errors";
import { refreshProjectProgress } from "@/lib/services/progress";
import { invalidateDownstreamReview } from "@/lib/services/review-state";
import { runPersistedAiStage } from "@/lib/services/provider-runs";

export async function addResearchQuestion(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  const input = researchQuestionSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
    if (input.parentId) {
      const parent = await client.query(
        "SELECT id FROM research_questions WHERE id = $1 AND project_id = $2",
        [input.parentId, projectId]
      );
      if (!parent.rowCount) {
        throw notFound("Parent research question");
      }
    }
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO research_questions (id, project_id, parent_id, question, priority, completion_criteria, research_gap, gap_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
      [
        id,
        projectId,
        input.parentId ?? null,
        input.question,
        input.priority,
        input.completionCriteria,
        input.researchGap ?? null,
        input.researchGap ? "OPEN" : "NONE"
      ]
    );
    await client.query(
      "UPDATE research_projects SET plan_approved_at = NULL, updated_at = NOW() WHERE id = $1",
      [projectId]
    );
    await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: "RESEARCH_QUESTION_CREATED",
      resourceType: "research_question",
      resourceId: id,
      afterState: result.rows[0]
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function updateResearchQuestion(
  projectId: string,
  questionId: string,
  input: {
    status?: "OPEN" | "PLANNED" | "RESEARCHING" | "COMPLETE" | "BLOCKED";
    gapStatus?: "NONE" | "OPEN" | "ACCEPTED" | "RESOLVED";
    researchGap?: string;
  },
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
    const before = await client.query(
      "SELECT * FROM research_questions WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [questionId, projectId]
    );
    if (!before.rows[0]) {
      throw notFound("Research question");
    }
    const result = await client.query(
      "UPDATE research_questions SET status = COALESCE($3, status), gap_status = COALESCE($4, gap_status), research_gap = COALESCE($5, research_gap), updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING *",
      [questionId, projectId, input.status ?? null, input.gapStatus ?? null, input.researchGap ?? null]
    );
    await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: "RESEARCH_QUESTION_UPDATED",
      resourceType: "research_question",
      resourceId: questionId,
      beforeState: before.rows[0],
      afterState: result.rows[0]
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function addResearchPlan(
  projectId: string,
  rawInput: unknown,
  actor: AuditActor = LOCAL_USER_AUDIT_ACTOR
): Promise<Record<string, unknown>> {
  const input = researchPlanSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const project = await client.query(
      "SELECT id FROM research_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!project.rowCount) {
      throw notFound("Project");
    }
    const question = await client.query(
      "SELECT id FROM research_questions WHERE id = $1 AND project_id = $2",
      [input.questionId, projectId]
    );
    if (!question.rowCount) {
      throw notFound("Research question");
    }
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO research_plans (id, project_id, question_id, search_strategy, search_queries, primary_source_types, secondary_source_types, comparison_targets, expected_output, completion_condition, expected_risks, research_gap, ai_suggested) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (question_id) DO UPDATE SET search_strategy = EXCLUDED.search_strategy, search_queries = EXCLUDED.search_queries, primary_source_types = EXCLUDED.primary_source_types, secondary_source_types = EXCLUDED.secondary_source_types, comparison_targets = EXCLUDED.comparison_targets, expected_output = EXCLUDED.expected_output, completion_condition = EXCLUDED.completion_condition, expected_risks = EXCLUDED.expected_risks, research_gap = EXCLUDED.research_gap, ai_suggested = EXCLUDED.ai_suggested, human_approved = FALSE, approved_at = NULL, updated_at = NOW() RETURNING *",
      [
        id,
        projectId,
        input.questionId,
        input.searchStrategy,
        input.searchQueries,
        input.primarySourceTypes,
        input.secondarySourceTypes,
        input.comparisonTargets,
        input.expectedOutput,
        input.completionCondition,
        input.expectedRisks,
        input.researchGap ?? null,
        input.aiSuggested
      ]
    );
    await client.query(
      "UPDATE research_projects SET plan_approved_at = NULL, updated_at = NOW() WHERE id = $1",
      [projectId]
    );
    await invalidateDownstreamReview(client, projectId, "RESEARCHING");
    await client.query(
      "UPDATE research_questions SET status = 'PLANNED', updated_at = NOW() WHERE id = $1 AND status = 'OPEN'",
      [input.questionId]
    );
    await writeAuditEvent(client, {
      projectId,
      ...actor,
      action: "RESEARCH_PLAN_SAVED",
      resourceType: "research_plan",
      resourceId: result.rows[0].id,
      afterState: { questionId: input.questionId, aiSuggested: input.aiSuggested }
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function generateProviderPlan(projectId: string): Promise<Record<string, unknown>> {
  const projectResult = await query<{
    id: string;
    core_question: string;
    scope: string;
    exclusions: string | null;
  }>("SELECT id, core_question, scope, exclusions FROM research_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    throw notFound("Project");
  }
  let questions = await query<{ id: string; question: string }>(
    "SELECT id, question FROM research_questions WHERE project_id = $1 ORDER BY created_at",
    [projectId]
  );
  if (questions.rows.length === 0) {
    const decomposition = await runPersistedAiStage({
      stage: "question_decomposition",
      projectId,
      promptTemplateVersion: "question-decomposition.v1",
      stageInput: {
        coreQuestion: project.core_question,
        scope: project.scope,
        completionCriteria: ["Every material answer is linked to verified evidence."]
      },
      allowedSourceIds: []
    });
    if (!decomposition.success) {
      throw new AppError(502, decomposition.error.code, decomposition.error.message);
    }
    const questionInputs = decomposition.output.questions.map((suggestion) => ({
      question: suggestion.question,
      priority: suggestion.priority,
      completionCriteria: suggestion.completionCriteria.join(" ")
    }));
    const parsedQuestionInputs = researchQuestionSchema.array().safeParse(questionInputs);
    if (!parsedQuestionInputs.success) {
      throw new AppError(
        502,
        "INVALID_AI_RESPONSE",
        "The AI questions did not meet the research question requirements."
      );
    }
    for (const input of parsedQuestionInputs.data) {
      await addResearchQuestion(projectId, input, CONFIGURED_PROVIDER_AUDIT_ACTOR);
    }
    questions = await query<{ id: string; question: string }>(
      "SELECT id, question FROM research_questions WHERE project_id = $1 ORDER BY created_at",
      [projectId]
    );
  }

  const generatedPlan = await runPersistedAiStage({
    stage: "research_plan",
    projectId,
    promptTemplateVersion: "research-plan.v1",
    stageInput: {
      questions: questions.rows,
      constraints: [project.scope, project.exclusions?.trim() || "No additional exclusions."]
    },
    allowedSourceIds: []
  });
  if (!generatedPlan.success) {
    throw new AppError(502, generatedPlan.error.code, generatedPlan.error.message);
  }
  const questionById = new Map(questions.rows.map((question) => [question.id, question]));
  const returnedQuestionIds = generatedPlan.output.steps.map((step) => step.questionId);
  if (
    returnedQuestionIds.length !== questionById.size ||
    new Set(returnedQuestionIds).size !== returnedQuestionIds.length ||
    returnedQuestionIds.some((questionId) => !questionById.has(questionId))
  ) {
    throw new AppError(
      502,
      "INVALID_AI_RESPONSE",
      "The AI plan must contain exactly one step for every project question."
    );
  }
  const planInputs = generatedPlan.output.steps.map((step) => ({
    questionId: step.questionId,
    searchStrategy: step.searchStrategy,
    searchQueries: step.queries,
    primarySourceTypes: step.primarySourceTypes,
    secondarySourceTypes: step.secondarySourceTypes,
    comparisonTargets: step.comparisonTargets,
    expectedOutput: step.expectedOutput,
    completionCondition: step.completionCondition,
    expectedRisks: step.risks,
    researchGap: step.researchGap ?? undefined,
    aiSuggested: true
  }));
  const parsedPlanInputs = researchPlanSchema.array().safeParse(planInputs);
  if (!parsedPlanInputs.success) {
    throw new AppError(
      502,
      "INVALID_AI_RESPONSE",
      "The AI plan did not meet the research plan requirements."
    );
  }
  const created: unknown[] = [];
  for (const input of parsedPlanInputs.data) {
    const question = questionById.get(input.questionId);
    if (!question) {
      throw new AppError(
        502,
        "INVALID_AI_RESPONSE",
        "The AI plan referenced a question outside this project."
      );
    }
    const plan = await addResearchPlan(projectId, input, CONFIGURED_PROVIDER_AUDIT_ACTOR);
    created.push({ question, plan });
  }
  return {
    projectId,
    items: created,
    provider: generatedPlan.metadata.provider,
    model: generatedPlan.metadata.model,
    aiRunInputHash: generatedPlan.metadata.inputHash
  };
}
