"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

export function EvidenceForm({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const target = event.currentTarget;
    const form = new FormData(target);
    const optional = (name: string) => String(form.get(name) ?? "").trim() || undefined;
    try {
      await apiRequest(`/api/sources/${encodeURIComponent(sourceId)}/evidence`, {
        method: "POST",
        body: JSON.stringify({
          summary: String(form.get("summary") ?? ""),
          minimalQuote: optional("minimalQuote"),
          originalLocation: optional("originalLocation"),
          pageOrSection: optional("pageOrSection"),
          confidence: String(form.get("confidence") ?? "MEDIUM"),
          verificationStatus: String(form.get("verificationStatus") ?? "PENDING"),
          supportExtent: String(form.get("supportExtent") ?? "FULL"),
        }),
      });
      target.reset();
      setMessage({ tone: "success", text: "Evidence excerpt added to the source." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Evidence creation failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Add evidence</h2><p>Keep quotes minimal and preserve an exact location for review.</p></div></div>
      <label className="field"><span>Evidence summary</span><textarea className="ui-textarea" maxLength={20000} minLength={3} name="summary" required /></label>
      <label className="field"><span>Minimal quote <small>Optional, maximum 2,000 characters</small></span><textarea className="ui-textarea ui-textarea--compact" maxLength={2000} name="minimalQuote" /></label>
      <div className="form-grid form-grid--two">
        <label className="field"><span>Original location</span><input className="ui-input" maxLength={1000} name="originalLocation" /></label>
        <label className="field"><span>Page or section</span><input className="ui-input" maxLength={500} name="pageOrSection" /></label>
      </div>
      <div className="form-grid form-grid--three">
        <label className="field"><span>Confidence</span><select className="ui-select" defaultValue="MEDIUM" name="confidence"><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>
        <label className="field"><span>Verification</span><select className="ui-select" defaultValue="PENDING" name="verificationStatus"><option>PENDING</option><option>VERIFIED</option><option>REJECTED</option></select></label>
        <label className="field"><span>Support extent</span><select className="ui-select" defaultValue="FULL" name="supportExtent"><option>FULL</option><option>PARTIAL</option></select></label>
      </div>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}{pending ? "Adding…" : "Add evidence"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}
