"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { ProjectRecord } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { ApiActionButton, MutationFeedback } from "./mutation-ui";
import { ScopeAiSuggestions } from "./ai-suggestions";

export function ScopeEditor({ project }: { project: ProjectRecord }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const deadline = String(form.get("deadline") ?? "").trim();
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          coreQuestion: String(form.get("coreQuestion") ?? ""),
          background: String(form.get("background") ?? ""),
          purpose: String(form.get("purpose") ?? ""),
          audience: String(form.get("audience") ?? ""),
          scope: String(form.get("scope") ?? ""),
          exclusions: String(form.get("exclusions") ?? ""),
          jurisdiction: String(form.get("jurisdiction") ?? ""),
          researchDate: String(form.get("researchDate") ?? ""),
          sourceMaxAgeDays: Number(form.get("sourceMaxAgeDays") ?? 365),
          ...(deadline ? { deadline } : {}),
          specialRequirements: String(form.get("specialRequirements") ?? ""),
        }),
      });
      setMessage({
        tone: "success",
        text: "Scope saved. Any prior scope, plan, QA, and approval confirmations were reset for review.",
      });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Scope update failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page-stack">
      <ScopeAiSuggestions project={project} />
      <form className="section-card form-stack" onSubmit={submit}>
        <div className="section-heading">
          <div><h2>Research boundaries</h2><p>Changing scope invalidates downstream approvals so they can be reviewed again.</p></div>
        </div>
        <label className="field">
          <span>Core research question</span>
          <textarea className="ui-textarea" defaultValue={project.core_question} maxLength={2000} minLength={10} name="coreQuestion" required />
        </label>
        <div className="form-grid form-grid--two">
          <label className="field"><span>Purpose</span><textarea className="ui-textarea" defaultValue={project.purpose} maxLength={4000} minLength={3} name="purpose" required /></label>
          <label className="field"><span>Audience</span><textarea className="ui-textarea" defaultValue={project.audience} maxLength={1000} minLength={2} name="audience" required /></label>
        </div>
        <label className="field"><span>Background</span><textarea className="ui-textarea" defaultValue={project.background ?? ""} maxLength={10000} name="background" /></label>
        <div className="form-grid form-grid--two">
          <label className="field"><span>In scope</span><textarea className="ui-textarea" defaultValue={project.scope} maxLength={10000} minLength={3} name="scope" required /></label>
          <label className="field"><span>Exclusions</span><textarea className="ui-textarea" defaultValue={project.exclusions ?? ""} maxLength={10000} name="exclusions" /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label className="field"><span>Jurisdiction</span><input className="ui-input" defaultValue={project.jurisdiction ?? ""} maxLength={500} name="jurisdiction" /></label>
          <label className="field"><span>Research as-of date</span><input className="ui-input" defaultValue={String(project.research_date).slice(0, 10)} name="researchDate" required type="date" /></label>
          <label className="field"><span>Maximum source age (days)</span><input className="ui-input" defaultValue={project.source_max_age_days} max="7300" min="0" name="sourceMaxAgeDays" required type="number" /></label>
        </div>
        <div className="form-grid form-grid--two">
          <label className="field"><span>Deadline <small>Optional</small></span><input className="ui-input" defaultValue={project.deadline?.slice(0, 10) ?? ""} name="deadline" type="date" /></label>
          <label className="field"><span>Special requirements</span><textarea className="ui-textarea ui-textarea--compact" defaultValue={project.special_requirements ?? ""} maxLength={10000} name="specialRequirements" /></label>
        </div>
        <div className="form-actions">
          <button className="ui-button" disabled={pending} type="submit">
            {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Save aria-hidden="true" />}
            {pending ? "Saving…" : "Save scope"}
          </button>
        </div>
        <MutationFeedback message={message} />
      </form>

      <section className="section-card approval-strip">
        <div><h2>Scope approval</h2><p>Confirm that the question, audience, boundaries, as-of date, and freshness requirements are ready for planning.</p></div>
        <ApiActionButton
          body={{}}
          endpoint={`/api/projects/${encodeURIComponent(project.id)}/scope`}
          label="Approve scope"
          pendingLabel="Approving…"
          successMessage="Scope approved. Planning is now available."
        />
      </section>
    </div>
  );
}
