"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { DeliverableRecord, ReportSectionValues } from "./model";
import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

const sectionFields: Array<{ key: keyof ReportSectionValues; label: string; guidance: string; tall?: boolean }> = [
  { key: "researchPurpose", label: "Research purpose", guidance: "Decision and audience this work supports." },
  { key: "executiveSummary", label: "Executive summary", guidance: "Answer-first summary with material caveats." },
  { key: "researchScope", label: "Research scope", guidance: "Included boundaries, exclusions, dates, and jurisdiction." },
  { key: "methodology", label: "Methodology", guidance: "Search, selection, verification, and synthesis methods." },
  { key: "keyFindings", label: "Key findings", guidance: "Most decision-relevant findings with source IDs in brackets.", tall: true },
  { key: "detailedAnalysis", label: "Detailed analysis", guidance: "Evidence-backed reasoning, conflicts, and interpretation.", tall: true },
  { key: "comparisonTable", label: "Comparison table", guidance: "Markdown table or structured comparison." },
  { key: "risksAndLimitations", label: "Risks and limitations", guidance: "Known gaps, uncertainty, and constraints.", tall: true },
  { key: "recommendations", label: "Recommendations", guidance: "Actions tied to findings, with inference labels where needed.", tall: true },
  { key: "references", label: "References", guidance: "Source IDs and full reference details.", tall: true },
  { key: "appendix", label: "Appendix", guidance: "Optional supporting material." },
];

export function ReportEditor({ projectId, deliverable }: { projectId: string; deliverable: DeliverableRecord }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const sections = Object.fromEntries(sectionFields.map(({ key }) => [key, String(form.get(key) ?? "")])) as unknown as ReportSectionValues;
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deliverable`, {
        method: "PUT",
        body: JSON.stringify({ title: String(form.get("title") ?? ""), sections, actorType: "USER" }),
      });
      setMessage({ tone: "success", text: "Report saved and revision history updated." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Report save failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section-card form-stack report-editor" onSubmit={submit}>
      <label className="field"><span>Report title</span><input className="ui-input report-title-input" defaultValue={deliverable.title} maxLength={500} minLength={3} name="title" required /></label>
      <p className="form-help">Citations use source IDs in square brackets, for example [source-id]. QA checks those IDs against project sources.</p>
      {sectionFields.map((field) => <label className="field report-section" key={field.key}><span>{field.label}<small>{field.guidance}</small></span><textarea className="ui-textarea code-input" defaultValue={deliverable.sections[field.key] ?? ""} maxLength={field.key === "detailedAnalysis" ? 200000 : field.key === "researchPurpose" || field.key === "executiveSummary" || field.key === "researchScope" || field.key === "methodology" ? 50000 : 100000} name={field.key} rows={field.tall ? 12 : 7} /></label>)}
      <div className="sticky-form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Save aria-hidden="true" />}{pending ? "Saving report…" : "Save report"}</button><MutationFeedback message={message} /></div>
    </form>
  );
}
