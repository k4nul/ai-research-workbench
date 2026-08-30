import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import {
  researchPlanSchema,
  researchQuestionSchema
} from "@/lib/validation";
import { writeAuditEvent } from "@/lib/services/audit";
import { notFound } from "@/lib/services/errors";
import { refreshProjectProgress } from "@/lib/services/progress";

export async function addResearchQuestion(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = researchQuestionSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const project = await client.query("SELECT id FROM research_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) {
      throw notFound("Project");
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
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
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
  }
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
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
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
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
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = researchPlanSchema.parse(rawInput);
  return withTransaction(async (client) => {
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
      "UPDATE research_questions SET status = 'PLANNED', updated_at = NOW() WHERE id = $1 AND status = 'OPEN'",
      [input.questionId]
    );
    await writeAuditEvent(client, {
      projectId,
      actorType: input.aiSuggested ? "AI" : "USER",
      actorLabel: input.aiSuggested ? "Configured provider" : "Local user",
      action: "RESEARCH_PLAN_SAVED",
      resourceType: "research_plan",
      resourceId: result.rows[0].id,
      afterState: { questionId: input.questionId, aiSuggested: input.aiSuggested }
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function generateDeterministicPlan(projectId: string): Promise<Record<string, unknown>> {
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
  const templates = [
    {
      question: "What evidence directly answers the core question?",
      priority: "CRITICAL" as const,
      completionCriteria: "At least two independent sources support or contest each key fact."
    },
    {
      question: "Which credible sources disagree, and why?",
      priority: "HIGH" as const,
      completionCriteria: "All material conflicts are linked to claims and explicitly reconciled."
    },
    {
      question: "What limitations or research gaps affect the conclusion?",
      priority: "HIGH" as const,
      completionCriteria: "All unresolved gaps are documented and accepted or resolved."
    }
  ];
  const created: unknown[] = [];
  for (const template of templates) {
    const question = await addResearchQuestion(projectId, template);
    const questionId = String(question.id);
    const plan = await addResearchPlan(projectId, {
      questionId,
      searchStrategy: "Start with authoritative primary sources, then triangulate using independent secondary sources.",
      searchQueries: [project.core_question, template.question],
      primarySourceTypes: ["PRIMARY_GUIDANCE", "OFFICIAL_DATA"],
      secondarySourceTypes: ["STUDY", "ANALYSIS"],
      comparisonTargets: ["supporting evidence", "contradicting evidence"],
      expectedOutput: "A cited answer, limitations, and any remaining gap.",
      completionCondition: template.completionCriteria,
      expectedRisks: ["source recency", "source concentration", "prompt injection"],
      researchGap: undefined,
      aiSuggested: true
    });
    created.push({ question, plan });
  }
  return { projectId, items: created, provider: "mock", deterministic: true };
}
