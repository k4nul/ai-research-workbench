"use client";

import { FileUp, Globe2, Link2, LoaderCircle, Plus, Search, Share2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { apiRequest, type MutationMessage } from "./client-api";
import { MutationFeedback } from "./mutation-ui";
import { uploadMutationFingerprint } from "./upload-idempotency";

type AcquisitionMode = "manual" | "search" | "fetch" | "upload" | "import" | "reuse";

const modes: Array<{ id: AcquisitionMode; label: string }> = [
  { id: "manual", label: "Manual" },
  { id: "search", label: "Search" },
  { id: "fetch", label: "Fetch URL" },
  { id: "upload", label: "Upload" },
  { id: "import", label: "Import" },
  { id: "reuse", label: "Reuse" },
];

function optional(form: FormData, key: string) {
  const value = String(form.get(key) ?? "").trim();
  return value || undefined;
}

export function SourceManager({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<AcquisitionMode>("manual");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);
  const uploadAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const root = `/api/projects/${encodeURIComponent(projectId)}/sources`;

  async function run(endpoint: string, init: RequestInit, success: string, form?: HTMLFormElement) {
    setPending(true);
    setMessage(null);
    try {
      await apiRequest(endpoint, init);
      form?.reset();
      setMessage({ tone: "success", text: success });
      router.refresh();
      return true;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Source action failed." });
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    await run(root, {
      method: "POST",
      body: JSON.stringify({
        url: optional(form, "url"),
        title: String(form.get("title") ?? ""),
        publisher: optional(form, "publisher"),
        author: optional(form, "author"),
        publishedAt: optional(form, "publishedAt"),
        sourceType: String(form.get("sourceType") ?? "WEB_PAGE"),
        language: String(form.get("language") ?? "en"),
        reliabilityGrade: String(form.get("reliabilityGrade") ?? "UNRATED"),
        usageRestrictions: optional(form, "usageRestrictions"),
        contentSummary: optional(form, "contentSummary"),
        sanitizedContent: optional(form, "sanitizedContent"),
        ingestionMethod: "MANUAL",
        mimeType: optional(form, "mimeType"),
      }),
    }, "Source added to this project.", target);
  }

  async function submitSimple(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    if (mode === "upload") {
      const fingerprint = await uploadMutationFingerprint(projectId, form);
      const attempt =
        uploadAttempt.current?.fingerprint === fingerprint
          ? uploadAttempt.current
          : { fingerprint, key: crypto.randomUUID() };
      uploadAttempt.current = attempt;
      const succeeded = await run(
        `${root}/upload`,
        { method: "POST", headers: { "Idempotency-Key": attempt.key }, body: form },
        "File uploaded and added as a source.",
        target
      );
      if (succeeded && uploadAttempt.current === attempt) uploadAttempt.current = null;
      return;
    }
    const payload =
      mode === "search"
        ? { query: String(form.get("query") ?? "") }
        : mode === "fetch"
          ? { url: String(form.get("url") ?? "") }
          : mode === "reuse"
            ? { sourceId: String(form.get("sourceId") ?? "") }
            : { content: String(form.get("content") ?? ""), format: String(form.get("format") ?? "json") };
    const successByMode: Record<AcquisitionMode, string> = {
      manual: "Source added to this project.",
      search: "Search completed and source results were processed.",
      fetch: "URL fetched and added as a source.",
      upload: "File uploaded and added as a source.",
      import: "Source data imported.",
      reuse: "Existing source reused in this project.",
    };
    await run(`${root}/${mode}`, { method: "POST", body: JSON.stringify(payload) }, successByMode[mode], target);
  }

  return (
    <section className="section-card">
      <div className="section-heading"><div><h2>Add or acquire sources</h2><p>Only stored, inspectable sources can contribute evidence.</p></div></div>
      <div aria-label="Source acquisition method" className="segmented-control segmented-control--wrap" role="tablist">
        {modes.map((item) => (
          <button aria-selected={mode === item.id} key={item.id} role="tab" type="button" onClick={() => { setMode(item.id); setMessage(null); }}>{item.label}</button>
        ))}
      </div>

      {mode === "manual" ? (
        <form className="form-stack" onSubmit={submitManual}>
          <div className="form-grid form-grid--two">
            <label className="field"><span>Title</span><input className="ui-input" maxLength={500} minLength={2} name="title" required /></label>
            <label className="field"><span>URL <small>Optional</small></span><input className="ui-input" name="url" type="url" /></label>
          </div>
          <div className="form-grid form-grid--three">
            <label className="field"><span>Publisher</span><input className="ui-input" maxLength={500} name="publisher" /></label>
            <label className="field"><span>Author</span><input className="ui-input" maxLength={500} name="author" /></label>
            <label className="field"><span>Published date</span><input className="ui-input" name="publishedAt" type="date" /></label>
          </div>
          <div className="form-grid form-grid--three">
            <label className="field"><span>Source type</span><input className="ui-input" defaultValue="WEB_PAGE" maxLength={80} minLength={2} name="sourceType" required /></label>
            <label className="field"><span>Language</span><input className="ui-input" defaultValue="en" maxLength={20} minLength={2} name="language" required /></label>
            <label className="field"><span>Reliability grade</span><select className="ui-select" defaultValue="UNRATED" name="reliabilityGrade"><option>A</option><option>B</option><option>C</option><option>D</option><option>UNRATED</option></select></label>
          </div>
          <label className="field"><span>Content summary</span><textarea className="ui-textarea ui-textarea--compact" maxLength={20000} name="contentSummary" /></label>
          <details className="form-details"><summary>Content and usage metadata</summary><div className="form-stack"><label className="field"><span>Sanitized content</span><textarea className="ui-textarea code-input" maxLength={200000} name="sanitizedContent" /></label><div className="form-grid form-grid--two"><label className="field"><span>Usage restrictions</span><input className="ui-input" maxLength={2000} name="usageRestrictions" /></label><label className="field"><span>MIME type</span><input className="ui-input" maxLength={100} name="mimeType" /></label></div></div></details>
          <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Plus aria-hidden="true" />}{pending ? "Adding…" : "Add source"}</button></div>
        </form>
      ) : (
        <form className="form-stack" onSubmit={submitSimple}>
          {mode === "search" ? <label className="field"><span>Search query</span><div className="input-with-icon"><Search aria-hidden="true" /><input className="ui-input" minLength={2} name="query" required /></div></label> : null}
          {mode === "fetch" ? <label className="field"><span>Public URL</span><div className="input-with-icon"><Globe2 aria-hidden="true" /><input className="ui-input" name="url" required type="url" /></div></label> : null}
          {mode === "upload" ? <label className="field"><span>Research file</span><input className="ui-input file-input" name="file" required type="file" /></label> : null}
          {mode === "import" ? <><label className="field"><span>Import format</span><select className="ui-select" name="format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><label className="field"><span>Source payload</span><textarea className="ui-textarea code-input" minLength={2} name="content" required rows={12} /></label></> : null}
          {mode === "reuse" ? <label className="field"><span>Existing source ID</span><div className="input-with-icon"><Share2 aria-hidden="true" /><input className="ui-input" minLength={1} name="sourceId" required /></div></label> : null}
          <div className="form-actions"><button className="ui-button" disabled={pending} type="submit">{pending ? <LoaderCircle aria-hidden="true" className="spin" /> : mode === "upload" ? <FileUp aria-hidden="true" /> : mode === "fetch" ? <Link2 aria-hidden="true" /> : <Plus aria-hidden="true" />}{pending ? "Working…" : `${modes.find((item) => item.id === mode)?.label} source`}</button></div>
        </form>
      )}
      <MutationFeedback message={message} />
    </section>
  );
}
