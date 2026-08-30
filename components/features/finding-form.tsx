"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { ClaimRecord, QuestionRecord } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

interface FindingFormProps {
  projectId: string;
  questions: QuestionRecord[];
  claims: ClaimRecord[];
}

export function FindingForm({ projectId, questions, claims }: FindingFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const target = event.currentTarget;
    const form = new FormData(target);
    const questionId = String(form.get("questionId") ?? "");
    const impact = String(form.get("impact") ?? "").trim();
    const limitations = String(form.get("limitations") ?? "").trim();
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/findings`, {
        method: "POST",
        body: JSON.stringify({
          ...(questionId ? { questionId } : {}),
          finding: String(form.get("finding") ?? ""),
          importance: String(form.get("importance") ?? "MEDIUM"),
          ...(impact ? { impact } : {}),
          ...(limitations ? { limitations } : {}),
          canInformRecommendation: form.get("canInformRecommendation") === "on",
          claimIds: form.getAll("claimIds").map(String),
        }),
      });
      target.reset();
      setMessage({ tone: "success", text: "Finding created with its selected claim links." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Finding creation failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Add finding</h2><p>Synthesize supported claims and state limitations beside the conclusion.</p></div></div>
      <label className="field"><span>Finding</span><textarea className="ui-textarea" maxLength={20000} minLength={3} name="finding" required /></label>
      <div className="form-grid form-grid--two">
        <label className="field"><span>Research question</span><select className="ui-select" name="questionId"><option value="">Cross-cutting</option>{questions.map((question) => <option key={question.id} value={question.id}>{question.question}</option>)}</select></label>
        <label className="field"><span>Importance</span><select className="ui-select" defaultValue="MEDIUM" name="importance"><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>
      </div>
      <div className="form-grid form-grid--two">
        <label className="field"><span>Impact</span><textarea className="ui-textarea ui-textarea--compact" maxLength={10000} name="impact" /></label>
        <label className="field"><span>Limitations</span><textarea className="ui-textarea ui-textarea--compact" maxLength={10000} name="limitations" /></label>
      </div>
      <fieldset className="claim-picker"><legend>Linked claims</legend>{claims.length ? claims.map((claim) => <label key={claim.id}><input name="claimIds" type="checkbox" value={claim.id} /><span><strong>{claim.importance} · {claim.support_status}</strong>{claim.content}</span></label>) : <p>No claims are available yet.</p>}</fieldset>
      <label className="check-field check-field--boxed"><input name="canInformRecommendation" type="checkbox" /><span>This finding may inform a recommendation</span></label>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}{pending ? "Adding…" : "Add finding"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}
