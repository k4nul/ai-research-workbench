"use client";

import { LoaderCircle, Plus, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { splitList } from "./format";
import type { PlanRecord, QuestionRecord } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { ApiActionButton, MutationFeedback } from "./mutation-ui";
import { PlanAiSuggestions } from "./ai-suggestions";

interface PlanWorkspaceProps {
  projectId: string;
  questions: QuestionRecord[];
  plans: PlanRecord[];
  constraints: string[];
}

function QuestionForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const target = event.currentTarget;
    const form = new FormData(target);
    const researchGap = String(form.get("researchGap") ?? "").trim();
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/questions`, {
        method: "POST",
        body: JSON.stringify({
          question: String(form.get("question") ?? ""),
          priority: String(form.get("priority") ?? "MEDIUM"),
          completionCriteria: String(form.get("completionCriteria") ?? ""),
          ...(researchGap ? { researchGap } : {}),
        }),
      });
      target.reset();
      setMessage({ tone: "success", text: "Research question added." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Question creation failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Add research question</h2><p>Each question needs an observable completion condition.</p></div></div>
      <label className="field"><span>Question</span><textarea className="ui-textarea ui-textarea--compact" maxLength={4000} minLength={5} name="question" required /></label>
      <div className="form-grid form-grid--two">
        <label className="field"><span>Priority</span><select className="ui-select" defaultValue="MEDIUM" name="priority"><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>
        <label className="field"><span>Known research gap <small>Optional</small></span><input className="ui-input" maxLength={4000} name="researchGap" /></label>
      </div>
      <label className="field"><span>Completion criteria</span><textarea className="ui-textarea ui-textarea--compact" maxLength={4000} minLength={3} name="completionCriteria" required /></label>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}{pending ? "Adding…" : "Add question"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}

function QuestionStateForm({ projectId, question }: { projectId: string; question: QuestionRecord }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(question.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: String(form.get("status")),
          gapStatus: String(form.get("gapStatus")),
          researchGap: String(form.get("researchGap") ?? ""),
        }),
      });
      setMessage({ tone: "success", text: "Question state updated." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Question update failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="compact-form" onSubmit={submit}>
      <label className="field"><span>Status</span><select className="ui-select" defaultValue={question.status} name="status"><option>OPEN</option><option>PLANNED</option><option>RESEARCHING</option><option>COMPLETE</option><option>BLOCKED</option></select></label>
      <label className="field"><span>Gap status</span><select className="ui-select" defaultValue={question.gap_status} name="gapStatus"><option>NONE</option><option>OPEN</option><option>ACCEPTED</option><option>RESOLVED</option></select></label>
      <label className="field compact-form__wide"><span>Gap note</span><input className="ui-input" defaultValue={question.research_gap ?? ""} maxLength={4000} name="researchGap" /></label>
      <button className="ui-button ui-button--secondary" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Save aria-hidden="true" />}{pending ? "Saving…" : "Update"}</button>
      <MutationFeedback message={message} />
    </form>
  );
}

function PlanEditor({ projectId, question, plan }: { projectId: string; question: QuestionRecord; plan?: PlanRecord }) {
  const router = useRouter();
  const [open, setOpen] = useState(!plan);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/plan`, {
        method: "POST",
        body: JSON.stringify({
          action: "save",
          plan: {
            questionId: question.id,
            searchStrategy: String(form.get("searchStrategy") ?? ""),
            searchQueries: splitList(form.get("searchQueries")),
            primarySourceTypes: splitList(form.get("primarySourceTypes")),
            secondarySourceTypes: splitList(form.get("secondarySourceTypes")),
            comparisonTargets: splitList(form.get("comparisonTargets")),
            expectedOutput: String(form.get("expectedOutput") ?? ""),
            completionCondition: String(form.get("completionCondition") ?? ""),
            expectedRisks: splitList(form.get("expectedRisks")),
            researchGap: String(form.get("researchGap") ?? ""),
            aiSuggested: false,
          },
        }),
      });
      setMessage({ tone: "success", text: "Plan saved and returned to human review." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Plan save failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="record-card">
      <header className="record-card__header">
        <div><p className="record-card__eyebrow">{question.priority} · {question.status}</p><h3>{question.question}</h3><p>{question.completion_criteria}</p></div>
        <button aria-expanded={open} className="ui-button ui-button--secondary" type="button" onClick={() => setOpen((value) => !value)}>{open ? "Hide plan" : plan ? "Edit plan" : "Create plan"}</button>
      </header>
      <QuestionStateForm projectId={projectId} question={question} />
      {open ? (
        <form className="form-stack form-subsection" onSubmit={submit}>
          <label className="field"><span>Search strategy</span><textarea className="ui-textarea" defaultValue={plan?.search_strategy ?? ""} maxLength={10000} minLength={3} name="searchStrategy" required /></label>
          <div className="form-grid form-grid--two">
            <label className="field"><span>Search queries <small>One per line</small></span><textarea className="ui-textarea" defaultValue={plan?.search_queries?.join("\n") ?? ""} name="searchQueries" /></label>
            <label className="field"><span>Comparison targets <small>One per line</small></span><textarea className="ui-textarea" defaultValue={plan?.comparison_targets?.join("\n") ?? ""} name="comparisonTargets" /></label>
          </div>
          <div className="form-grid form-grid--two">
            <label className="field"><span>Primary source types</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.primary_source_types?.join("\n") ?? ""} name="primarySourceTypes" /></label>
            <label className="field"><span>Secondary source types</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.secondary_source_types?.join("\n") ?? ""} name="secondarySourceTypes" /></label>
          </div>
          <div className="form-grid form-grid--two">
            <label className="field"><span>Expected output</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.expected_output ?? ""} maxLength={4000} minLength={3} name="expectedOutput" required /></label>
            <label className="field"><span>Completion condition</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.completion_condition ?? question.completion_criteria} maxLength={4000} minLength={3} name="completionCondition" required /></label>
          </div>
          <div className="form-grid form-grid--two">
            <label className="field"><span>Expected risks <small>One per line</small></span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.expected_risks?.join("\n") ?? ""} name="expectedRisks" /></label>
            <label className="field"><span>Research gap</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={plan?.research_gap ?? question.research_gap ?? ""} maxLength={4000} name="researchGap" /></label>
          </div>
          <div className="form-actions">
            <button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Save aria-hidden="true" />}{pending ? "Saving…" : "Save plan"}</button>
            {plan && !plan.human_approved ? <ApiActionButton body={{ action: "approve", planId: plan.id }} endpoint={`/api/projects/${encodeURIComponent(projectId)}/plan`} label="Approve this plan" successMessage="Plan item approved." /> : null}
          </div>
          <MutationFeedback message={message} />
        </form>
      ) : null}
    </article>
  );
}

export function PlanWorkspace({ projectId, questions, plans, constraints }: PlanWorkspaceProps) {
  const plansByQuestion = new Map(plans.map((plan) => [plan.question_id, plan]));
  return (
    <div className="page-stack">
      <section className="section-card approval-strip">
        <div><h2>Planning actions</h2><p>Generate a provider-backed starter plan (local mock by default), then review and approve every plan item.</p></div>
        <div className="action-cluster">
          <ApiActionButton body={{ action: "generate" }} endpoint={`/api/projects/${encodeURIComponent(projectId)}/plan`} label="Generate starter plan" pendingLabel="Generating…" successMessage="Starter questions and plans generated." />
          <ApiActionButton body={{ action: "approve" }} className="ui-button ui-button--secondary" disabled={plans.length === 0} endpoint={`/api/projects/${encodeURIComponent(projectId)}/plan`} label="Approve all plans" successMessage="All current plan items approved." />
        </div>
      </section>
      <PlanAiSuggestions constraints={constraints} projectId={projectId} questions={questions} />
      <QuestionForm projectId={projectId} />
      <section className="section-card">
        <div className="section-heading"><div><h2>Questions and plans</h2><p>{questions.length} question{questions.length === 1 ? "" : "s"}; {plans.length} plan item{plans.length === 1 ? "" : "s"}.</p></div></div>
        {questions.length ? <div className="record-list">{questions.map((question) => <PlanEditor key={question.id} plan={plansByQuestion.get(question.id)} projectId={projectId} question={question} />)}</div> : <p className="muted-copy">No questions yet. Add one manually or generate a starter plan.</p>}
      </section>
    </div>
  );
}
