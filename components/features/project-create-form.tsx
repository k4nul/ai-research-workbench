"use client";

import { FileJson2, FileText, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";

type IntakeMode = "quick" | "detailed";
type EntryMode = "form" | "import";

function optional(form: FormData, name: string) {
  const value = String(form.get(name) ?? "").trim();
  return value || undefined;
}

function createdProjectId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

export function ProjectCreateForm({ today }: { today: string }) {
  const router = useRouter();
  const [entryMode, setEntryMode] = useState<EntryMode>("form");
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("quick");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const deliverableFormats = form.getAll("deliverableFormats").map(String);
    if (deliverableFormats.length === 0) {
      setPending(false);
      setMessage({ tone: "error", text: "Select at least one deliverable format." });
      return;
    }
    try {
      const result = await apiRequest("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          mode: intakeMode,
          name: String(form.get("name") ?? ""),
          clientName: optional(form, "clientName"),
          coreQuestion: String(form.get("coreQuestion") ?? ""),
          background: String(form.get("background") ?? ""),
          purpose: String(form.get("purpose") ?? ""),
          audience: String(form.get("audience") ?? ""),
          scope: String(form.get("scope") ?? ""),
          exclusions: String(form.get("exclusions") ?? ""),
          jurisdiction: String(form.get("jurisdiction") ?? ""),
          researchDate: String(form.get("researchDate") ?? today),
          sourceMaxAgeDays: Number(form.get("sourceMaxAgeDays") ?? 365),
          deadline: optional(form, "deadline"),
          deliverableFormats,
          specialRequirements: String(form.get("specialRequirements") ?? ""),
        }),
      });
      const projectId = createdProjectId(result);
      if (!projectId) throw new Error("The project was created without a usable identifier.");
      router.push(`/projects/${encodeURIComponent(projectId)}`);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Project creation failed.",
      });
      setPending(false);
    }
  }

  async function importProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest("/api/projects/import", {
        method: "POST",
        body: JSON.stringify({
          format: String(form.get("format") ?? "json"),
          content: String(form.get("content") ?? ""),
        }),
      });
      const projectId = createdProjectId(result);
      if (!projectId) throw new Error("The imported project has no usable identifier.");
      router.push(`/projects/${encodeURIComponent(projectId)}`);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Project import failed.",
      });
      setPending(false);
    }
  }

  return (
    <section className="section-card">
      <div aria-label="Project intake method" className="segmented-control" role="tablist">
        <button
          aria-selected={entryMode === "form"}
          role="tab"
          type="button"
          onClick={() => setEntryMode("form")}
        >
          <Plus aria-hidden="true" /> New intake
        </button>
        <button
          aria-selected={entryMode === "import"}
          role="tab"
          type="button"
          onClick={() => setEntryMode("import")}
        >
          <FileJson2 aria-hidden="true" /> Import brief
        </button>
      </div>

      {entryMode === "form" ? (
        <form className="form-stack" onSubmit={createProject}>
          <fieldset className="choice-fieldset">
            <legend>Intake depth</legend>
            <label>
              <input
                checked={intakeMode === "quick"}
                name="mode"
                type="radio"
                value="quick"
                onChange={() => setIntakeMode("quick")}
              />
              <span><strong>Quick</strong><small>Core brief and defaults.</small></span>
            </label>
            <label>
              <input
                checked={intakeMode === "detailed"}
                name="mode"
                type="radio"
                value="detailed"
                onChange={() => setIntakeMode("detailed")}
              />
              <span><strong>Detailed</strong><small>Constraints, freshness, and delivery details.</small></span>
            </label>
          </fieldset>

          <div className="form-grid form-grid--two">
            <label className="field">
              <span>Project name</span>
              <input className="ui-input" maxLength={160} minLength={3} name="name" required />
            </label>
            <label className="field">
              <span>Client or organization <small>Optional</small></span>
              <input className="ui-input" maxLength={160} name="clientName" />
            </label>
          </div>
          <label className="field">
            <span>Core research question</span>
            <textarea className="ui-textarea" maxLength={2000} minLength={10} name="coreQuestion" required />
          </label>
          <div className="form-grid form-grid--two">
            <label className="field">
              <span>Purpose</span>
              <textarea className="ui-textarea ui-textarea--compact" maxLength={4000} minLength={3} name="purpose" required />
            </label>
            <label className="field">
              <span>Audience</span>
              <textarea className="ui-textarea ui-textarea--compact" maxLength={1000} minLength={2} name="audience" required />
            </label>
          </div>
          <label className="field">
            <span>In scope</span>
            <textarea className="ui-textarea" maxLength={10000} minLength={3} name="scope" required />
          </label>

          {intakeMode === "detailed" ? (
            <div className="form-stack form-subsection">
              <label className="field">
                <span>Background</span>
                <textarea className="ui-textarea" maxLength={10000} name="background" />
              </label>
              <div className="form-grid form-grid--two">
                <label className="field">
                  <span>Exclusions</span>
                  <textarea className="ui-textarea ui-textarea--compact" maxLength={10000} name="exclusions" />
                </label>
                <label className="field">
                  <span>Jurisdiction</span>
                  <textarea className="ui-textarea ui-textarea--compact" maxLength={500} name="jurisdiction" />
                </label>
              </div>
              <label className="field">
                <span>Special requirements</span>
                <textarea className="ui-textarea" maxLength={10000} name="specialRequirements" />
              </label>
            </div>
          ) : null}

          <div className="form-grid form-grid--three">
            <label className="field">
              <span>Research as-of date</span>
              <input className="ui-input" defaultValue={today} name="researchDate" required type="date" />
            </label>
            <label className="field">
              <span>Maximum source age (days)</span>
              <input className="ui-input" defaultValue="365" max="7300" min="0" name="sourceMaxAgeDays" required type="number" />
            </label>
            {intakeMode === "detailed" ? (
              <label className="field">
                <span>Deadline <small>Optional</small></span>
                <input className="ui-input" name="deadline" type="date" />
              </label>
            ) : null}
          </div>

          <fieldset className="checkbox-group">
            <legend>Deliverable formats</legend>
            {["MARKDOWN", "HTML", "PDF", "DOCX", "CSV"].map((format) => (
              <label key={format}>
                <input
                  defaultChecked={["MARKDOWN", "HTML", "PDF", "DOCX", "ZIP"].includes(format)}
                  name="deliverableFormats"
                  type="checkbox"
                  value={format}
                />
                {format}
              </label>
            ))}
            <label title="A current ZIP package is required before delivery.">
              <input checked disabled type="checkbox" />
              ZIP (required package)
              <input name="deliverableFormats" type="hidden" value="ZIP" />
            </label>
          </fieldset>
          <div className="form-actions">
            <button className="ui-button" disabled={pending} type="submit">
              {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}
              {pending ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      ) : (
        <form className="form-stack" onSubmit={importProject}>
          <div className="notice notice--info">
            <FileText aria-hidden="true" />
            <p>JSON must match the intake schema. Markdown uses an H1 project title and H2 fields such as Core question, Purpose, Audience, and Scope.</p>
          </div>
          <label className="field">
            <span>Import format</span>
            <select className="ui-select" name="format">
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </label>
          <label className="field">
            <span>Brief content</span>
            <textarea className="ui-textarea code-input" minLength={2} name="content" required rows={18} />
          </label>
          <div className="form-actions">
            <button className="ui-button" disabled={pending} type="submit">
              {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <FileJson2 aria-hidden="true" />}
              {pending ? "Importing…" : "Import and create"}
            </button>
          </div>
        </form>
      )}
      <MutationFeedback message={message} />
    </section>
  );
}
