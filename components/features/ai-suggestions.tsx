"use client";

import { BrainCircuit, LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";

import { humanize } from "./format";
import type { ProjectRecord, QuestionRecord } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

type SuggestionStage =
  | "intake_analysis"
  | "question_decomposition"
  | "research_plan";

interface SuggestionRun {
  success: true;
  output: unknown;
  metadata: {
    provider: string;
    model: string;
    durationMs: number;
    promptTemplateVersion: string;
  };
}

function successfulRun(value: unknown): SuggestionRun {
  if (!value || typeof value !== "object") {
    throw new Error("The provider returned an unreadable response.");
  }
  const result = value as {
    success?: boolean;
    output?: unknown;
    error?: { message?: string };
    metadata?: SuggestionRun["metadata"];
  };
  if (!result.success) {
    throw new Error(result.error?.message ?? "The configured AI provider could not complete this stage.");
  }
  if (!result.metadata) {
    throw new Error("The provider response is missing reproducibility metadata.");
  }
  return {
    success: true,
    output: result.output,
    metadata: result.metadata,
  };
}

function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted-copy">None suggested</span>;
    return (
      <ol className="suggestion-list">
        {value.map((item, index) => (
          <li key={index}>
            <StructuredValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (value && typeof value === "object") {
    return (
      <dl className="suggestion-fields">
        {Object.entries(value as Record<string, unknown>).map(([key, child]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd><StructuredValue value={child} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  return <span>{String(value ?? "Not provided")}</span>;
}

function SuggestionResult({ stage, run }: { stage: SuggestionStage; run: SuggestionRun }) {
  return (
    <article className="suggestion-result">
      <header>
        <div>
          <p className="record-card__eyebrow">{humanize(stage)} suggestion</p>
          <h3>Review the structured output</h3>
        </div>
        <span>{run.metadata.provider} · {run.metadata.model} · {run.metadata.durationMs} ms</span>
      </header>
      <StructuredValue value={run.output} />
      <p className="suggestion-result__notice">Suggestion only. Copy or adapt useful material in the human-controlled fields; this run did not save or approve anything.</p>
    </article>
  );
}

interface SuggestionAction {
  stage: SuggestionStage;
  label: string;
  input: unknown;
  promptTemplateVersion: string;
}

function AiSuggestionPanel({
  projectId,
  title,
  description,
  actions,
}: {
  projectId: string;
  title: string;
  description: string;
  actions: SuggestionAction[];
}) {
  const [pendingStage, setPendingStage] = useState<SuggestionStage | null>(null);
  const [runs, setRuns] = useState<Partial<Record<SuggestionStage, SuggestionRun>>>({});
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function runSuggestion(action: SuggestionAction) {
    setPendingStage(action.stage);
    setMessage(null);
    try {
      const result = successfulRun(
        await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/pipeline`, {
          method: "POST",
          body: JSON.stringify({
            stage: action.stage,
            promptTemplateVersion: action.promptTemplateVersion,
            input: action.input,
            allowedSourceIds: [],
          }),
        }),
      );
      setRuns((current) => ({ ...current, [action.stage]: result }));
      setMessage({
        tone: "success",
        text: `${humanize(action.stage)} completed. Review the suggestion below; no workflow record was changed.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The AI suggestion failed.",
      });
    } finally {
      setPendingStage(null);
    }
  }

  return (
    <section className="section-card ai-suggestion-panel">
      <div className="section-heading">
        <div><h2>{title}</h2><p>{description}</p></div>
        <BrainCircuit aria-hidden="true" />
      </div>
      <div className="action-cluster">
        {actions.map((action) => (
          <button
            className="ui-button ui-button--secondary"
            disabled={pendingStage !== null}
            key={action.stage}
            type="button"
            onClick={() => runSuggestion(action)}
          >
            {pendingStage === action.stage ? <LoaderCircle aria-hidden="true" className="spin" /> : <Sparkles aria-hidden="true" />}
            {pendingStage === action.stage ? "Generating…" : action.label}
          </button>
        ))}
      </div>
      <MutationFeedback message={message} />
      {actions.map((action) => runs[action.stage] ? <SuggestionResult key={action.stage} run={runs[action.stage]!} stage={action.stage} /> : null)}
    </section>
  );
}

export function ScopeAiSuggestions({ project }: { project: ProjectRecord }) {
  return (
    <AiSuggestionPanel
      actions={[
        {
          stage: "intake_analysis",
          label: "Analyze saved scope",
          promptTemplateVersion: "ui.intake-analysis.v1",
          input: {
            brief: `${project.core_question}\n\n${project.background ?? ""}`.trim(),
            audience: project.audience,
            jurisdiction: project.jurisdiction ?? undefined,
            asOfDate: project.research_date,
          },
        },
        {
          stage: "question_decomposition",
          label: "Suggest research questions",
          promptTemplateVersion: "ui.question-decomposition.v1",
          input: {
            coreQuestion: project.core_question,
            scope: project.scope,
            completionCriteria: [
              `Answer for ${project.audience}.`,
              "Every material claim is linked to evidence or recorded as a research gap.",
            ],
          },
        },
      ]}
      description="Run the configured provider against the last saved scope. Outputs are persisted for reproducibility but remain suggestions until a person edits and saves records."
      projectId={project.id}
      title="AI scope review"
    />
  );
}

export function PlanAiSuggestions({
  projectId,
  questions,
  constraints,
}: {
  projectId: string;
  questions: QuestionRecord[];
  constraints: string[];
}) {
  return (
    <AiSuggestionPanel
      actions={[
        {
          stage: "research_plan",
          label: "Suggest source-first plan",
          promptTemplateVersion: "ui.research-plan.v1",
          input: {
            questions: questions.map((question) => ({ id: question.id, question: question.question })),
            constraints,
          },
        },
      ]}
      description="Ask the configured provider for queries, source types, completion conditions, and risks for the current saved questions. Suggestions are never auto-saved or approved."
      projectId={projectId}
      title="AI plan suggestion"
    />
  );
}
