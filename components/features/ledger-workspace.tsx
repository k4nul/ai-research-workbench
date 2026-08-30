"use client";

import { FilePenLine, Link2, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { ClaimRecord, EvidenceRecord, QuestionRecord } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

interface LedgerWorkspaceProps {
  projectId: string;
  questions: QuestionRecord[];
  claims: ClaimRecord[];
  evidence: EvidenceRecord[];
}

function ClaimForm({ projectId, questions }: Pick<LedgerWorkspaceProps, "projectId" | "questions">) {
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
    const resolutionNotes = String(form.get("resolutionNotes") ?? "").trim();
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/claims`, {
        method: "POST",
        body: JSON.stringify({
          ...(questionId ? { questionId } : {}),
          content: String(form.get("content") ?? ""),
          claimType: String(form.get("claimType") ?? "FACT"),
          importance: String(form.get("importance") ?? "MEDIUM"),
          factOrInference: String(form.get("factOrInference") ?? "FACT"),
          verificationPossible: form.get("verificationPossible") === "on",
          withinScope: form.get("withinScope") === "on",
          includeInReport: form.get("includeInReport") === "on",
          ...(resolutionNotes ? { resolutionNotes } : {}),
        }),
      });
      target.reset();
      setMessage({ tone: "success", text: "Claim added. Link verified evidence before relying on it." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Claim creation failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Add claim</h2><p>Classify facts and inferences explicitly so QA can check them.</p></div></div>
      <label className="field"><span>Claim</span><textarea className="ui-textarea" maxLength={20000} minLength={3} name="content" required /></label>
      <div className="form-grid form-grid--three">
        <label className="field"><span>Question</span><select className="ui-select" name="questionId"><option value="">Unassigned</option>{questions.map((question) => <option key={question.id} value={question.id}>{question.question}</option>)}</select></label>
        <label className="field"><span>Claim type</span><select className="ui-select" name="claimType"><option>FACT</option><option>INTERPRETATION</option><option>INFERENCE</option><option>RECOMMENDATION</option></select></label>
        <label className="field"><span>Importance</span><select className="ui-select" defaultValue="MEDIUM" name="importance"><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>
      </div>
      <div className="form-grid form-grid--three">
        <label className="field"><span>Statement class</span><select className="ui-select" name="factOrInference"><option>FACT</option><option>INFERENCE</option></select></label>
        <label className="check-field check-field--boxed"><input defaultChecked name="verificationPossible" type="checkbox" /><span>This claim can be verified</span></label>
        <label className="check-field check-field--boxed"><input defaultChecked name="withinScope" type="checkbox" /><span>Within the approved scope</span></label>
      </div>
      <div className="form-grid form-grid--three">
        <label className="check-field check-field--boxed"><input defaultChecked name="includeInReport" type="checkbox" /><span>Eligible for inclusion in the report</span></label>
      </div>
      <label className="field"><span>Resolution notes <small>Optional conflict or scope rationale</small></span><textarea className="ui-textarea ui-textarea--compact" maxLength={4000} name="resolutionNotes" /></label>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}{pending ? "Adding…" : "Add claim"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}

function EvidenceLinkForm({ projectId, claims, evidence }: Pick<LedgerWorkspaceProps, "projectId" | "claims" | "evidence">) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const notes = String(form.get("notes") ?? "").trim();
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ledger`, {
        method: "POST",
        body: JSON.stringify({
          claimId: String(form.get("claimId") ?? ""),
          evidenceId: String(form.get("evidenceId") ?? ""),
          relationship: String(form.get("relationship") ?? "SUPPORTS"),
          ...(notes ? { notes } : {}),
        }),
      });
      setMessage({ tone: "success", text: "Evidence relationship saved and claim support recalculated." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Evidence link failed." });
    } finally {
      setPending(false);
    }
  }

  if (!claims.length || !evidence.length) {
    return <section className="section-card"><div className="section-heading"><div><h2>Link evidence</h2><p>Create at least one claim and one evidence excerpt before linking them.</p></div></div></section>;
  }
  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Link evidence</h2><p>Support, refute, or add context to a claim using project evidence.</p></div></div>
      <label className="field"><span>Claim</span><select className="ui-select" name="claimId" required>{claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.content}</option>)}</select></label>
      <label className="field"><span>Evidence</span><select className="ui-select" name="evidenceId" required>{evidence.map((item) => <option key={item.id} value={item.id}>{item.source_title ? `${item.source_title}: ` : ""}{item.summary}</option>)}</select></label>
      <div className="form-grid form-grid--two">
        <label className="field"><span>Relationship</span><select className="ui-select" name="relationship"><option>SUPPORTS</option><option>REFUTES</option><option>CONTEXT</option></select></label>
        <label className="field"><span>Link notes</span><input className="ui-input" maxLength={2000} name="notes" /></label>
      </div>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Link2 aria-hidden="true" />}{pending ? "Linking…" : "Link evidence"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}

function ClaimReviewForm({ projectId, claims }: Pick<LedgerWorkspaceProps, "projectId" | "claims">) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const claimId = String(form.get("claimId") ?? "");
    const resolutionNotes = String(form.get("resolutionNotes") ?? "").trim();
    const inclusion = String(form.get("inclusion") ?? "KEEP");
    const scope = String(form.get("scope") ?? "KEEP");
    if (!resolutionNotes && inclusion === "KEEP" && scope === "KEEP") {
      setMessage({ tone: "error", text: "Add a resolution note or change report inclusion or scope." });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}/claims/${encodeURIComponent(claimId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(resolutionNotes ? { resolutionNotes } : {}),
            ...(inclusion === "KEEP" ? {} : { includeInReport: inclusion === "INCLUDE" }),
            ...(scope === "KEEP" ? {} : { withinScope: scope === "IN_SCOPE" }),
          }),
        },
      );
      setMessage({ tone: "success", text: "Claim review decision saved; QA and approval were invalidated." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Claim review update failed." });
    } finally {
      setPending(false);
    }
  }

  if (!claims.length) return null;
  return (
    <form className="section-card form-stack" onSubmit={submit}>
      <div className="section-heading"><div><h2>Resolve or exclude a claim</h2><p>Record how a conflict or limitation was handled, or remove the claim from the report set. Every change requires a fresh QA run.</p></div></div>
      <label className="field"><span>Claim</span><select className="ui-select" name="claimId" required>{claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.content}</option>)}</select></label>
      <div className="form-grid form-grid--three">
        <label className="field"><span>Report inclusion</span><select className="ui-select" defaultValue="KEEP" name="inclusion"><option value="KEEP">Keep current decision</option><option value="INCLUDE">Include in report</option><option value="EXCLUDE">Exclude from report</option></select></label>
        <label className="field"><span>Approved scope</span><select className="ui-select" defaultValue="KEEP" name="scope"><option value="KEEP">Keep current decision</option><option value="IN_SCOPE">Within scope</option><option value="OUT_OF_SCOPE">Outside scope</option></select></label>
        <label className="field"><span>Resolution note</span><textarea className="ui-textarea ui-textarea--compact" maxLength={4000} minLength={3} name="resolutionNotes" /></label>
      </div>
      <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <FilePenLine aria-hidden="true" />}{pending ? "Saving…" : "Save claim decision"}</button></div>
      <MutationFeedback message={message} />
    </form>
  );
}

export function LedgerWorkspace(props: LedgerWorkspaceProps) {
  return <><div className="split-grid"><ClaimForm projectId={props.projectId} questions={props.questions} /><EvidenceLinkForm claims={props.claims} evidence={props.evidence} projectId={props.projectId} /></div><ClaimReviewForm claims={props.claims} projectId={props.projectId} /></>;
}
