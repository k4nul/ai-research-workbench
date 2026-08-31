"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  apiRequest,
  type MutationMessage
} from "@/components/features/client-api";
import { MutationFeedback } from "@/components/features/mutation-ui";
import { uploadMutationFingerprint } from "@/components/features/upload-idempotency";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/ui";

type ProjectOption = { id: string; name: string };
type DocumentRecord = {
  id: string;
  projectId: string;
  title: string;
  originalFilename?: string | null;
  filename?: string;
  status?: string;
  uploadStatus?: string;
  scanStatus?: string;
  extractionStatus?: string;
  byteSize?: number | null;
  contentType?: string;
  updatedAt?: string;
};

type DocumentLoadResult = {
  requestKey: string;
  documents: DocumentRecord[];
  error: string | null;
};

export function DocumentsBrowser({ projects }: { projects: readonly ProjectOption[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [result, setResult] = useState<DocumentLoadResult>({
    requestKey: "",
    documents: [],
    error: null
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<MutationMessage | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<MutationMessage | null>(null);
  const uploadAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const requestKey = `${projectId}:${reloadKey}`;

  useEffect(() => {
    let active = true;
    if (!projectId) {
      return () => {
        active = false;
      };
    }
    void apiRequest(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
      method: "GET"
    })
      .then((value) => {
        if (active) {
          setResult({
            requestKey,
            documents: Array.isArray(value) ? (value as DocumentRecord[]) : [],
            error: null
          });
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setResult({
            requestKey,
            documents: [],
            error: caught instanceof Error ? caught.message : "Documents could not be loaded."
          });
        }
      });
    return () => {
      active = false;
    };
  }, [projectId, requestKey]);

  const loading = Boolean(projectId) && result.requestKey !== requestKey;
  const documents = loading ? null : result.documents;
  const error = loading ? null : result.error;

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setUploadMessage({ tone: "error", text: "Choose a non-empty document file." });
      return;
    }
    const fingerprint = await uploadMutationFingerprint(projectId, form);
    if (uploadAttempt.current?.fingerprint !== fingerprint) {
      uploadAttempt.current = { fingerprint, key: crypto.randomUUID() };
    }
    setUploadPending(true);
    setUploadMessage(null);
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
        method: "POST",
        headers: { "Idempotency-Key": uploadAttempt.current.key },
        body: form
      });
      uploadAttempt.current = null;
      formElement.reset();
      setUploadMessage({
        tone: "success",
        text: "Document quarantined. Malware scanning was queued before extraction."
      });
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setUploadMessage({
        tone: "error",
        text: caught instanceof Error ? caught.message : "The document could not be uploaded."
      });
    } finally {
      setUploadPending(false);
    }
  }

  async function mutateDocument(
    document: DocumentRecord,
    action: "scan" | "extract" | "delete"
  ) {
    const attempt = `${document.id}:${action}`;
    if (action === "delete" && !window.confirm("Delete this document and queue private-object cleanup?")) {
      return;
    }
    const key = actionKeys.current.get(attempt) ?? crypto.randomUUID();
    actionKeys.current.set(attempt, key);
    setPendingAction(attempt);
    setActionMessage(null);
    try {
      const documentEndpoint = `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}`;
      await apiRequest(
        action === "delete" ? documentEndpoint : `${documentEndpoint}/${action}`,
        {
          method: action === "delete" ? "DELETE" : "POST",
          headers: { "Idempotency-Key": key },
          body: action === "delete" ? undefined : JSON.stringify({})
        }
      );
      actionKeys.current.delete(attempt);
      setActionMessage({
        tone: "success",
        text:
          action === "scan"
            ? "Malware scan queued."
            : action === "extract"
              ? "Safe extraction queued."
              : "Document deletion recorded; object cleanup is pending."
      });
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setActionMessage({
        tone: "error",
        text: caught instanceof Error ? caught.message : "The document action failed."
      });
    } finally {
      setPendingAction(null);
    }
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        action={<Link className="ui-link-button" href="/projects/new">Create project</Link>}
        description="Documents are scoped to a research project."
        title="No projects available"
      />
    );
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <label className="field">
          <span>Project</span>
          <select
            className="ui-select"
            value={projectId}
            onChange={(event) => {
              uploadAttempt.current = null;
              actionKeys.current.clear();
              setUploadMessage(null);
              setActionMessage(null);
              setProjectId(event.currentTarget.value);
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
      </section>
      <section className="section-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Private quarantine</p>
            <h2>Upload a document</h2>
          </div>
        </div>
        <p>
          PDF, DOCX, TXT, HTML, Markdown, CSV, and JSON stay unavailable to extraction and AI
          stages until a clean malware-scan result is recorded. A clean result reduces risk; it
          does not guarantee that a file is safe.
        </p>
        <form className="compact-form" onSubmit={upload}>
          <label className="field">
            <span>Document file</span>
            <input
              accept=".pdf,.docx,.txt,.html,.htm,.md,.csv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/html,text/markdown,text/csv,application/json"
              className="ui-input"
              name="file"
              required
              type="file"
            />
          </label>
          <label className="field">
            <span>Source title <small>Optional</small></span>
            <input className="ui-input" maxLength={500} name="title" />
          </label>
          <div className="form-actions">
            <button className="ui-button" disabled={uploadPending} type="submit">
              {uploadPending ? "Uploading…" : "Upload to quarantine"}
            </button>
          </div>
          <MutationFeedback message={uploadMessage} />
        </form>
      </section>
      <MutationFeedback message={actionMessage} />
      {error ? (
        <ErrorState
          description={error}
          retryLabel="Reload documents"
          title="Documents unavailable"
          onRetry={() => setReloadKey((value) => value + 1)}
        />
      ) : null}
      {!error && documents === null ? (
        <LoadingState description="Loading project-scoped document processing state." />
      ) : null}
      {!error && documents?.length === 0 ? (
        <EmptyState
          description="Upload documents from the project Sources workspace."
          title="No documents in this project"
        />
      ) : null}
      {documents?.map((document) => (
        <article className="section-card" key={document.id}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Document</p>
              <h2>{document.title || document.originalFilename || document.filename || document.id}</h2>
            </div>
            <div className="badge-stack badge-stack--horizontal">
              <StatusBadge status={document.status ?? document.uploadStatus ?? "UNKNOWN"} />
              {document.scanStatus ? <StatusBadge status={document.scanStatus} /> : null}
              {document.extractionStatus ? <StatusBadge status={document.extractionStatus} /> : null}
            </div>
          </div>
          <dl className="definition-grid">
            <div><dt>Filename</dt><dd>{document.originalFilename ?? document.filename ?? "Not recorded"}</dd></div>
            <div><dt>Size</dt><dd>{document.byteSize === null || document.byteSize === undefined ? "Not recorded" : `${(document.byteSize / 1_024).toFixed(1)} KB`}</dd></div>
            <div><dt>Content type</dt><dd>{document.contentType ?? "Not recorded"}</dd></div>
          </dl>
          <div className="table-actions">
            {(["QUARANTINED", "BLOCKED_SCANNER_UNAVAILABLE", "SCANNING"] as string[]).includes(
              document.status ?? ""
            ) ? (
              <button
                className="ui-button ui-button--secondary"
                disabled={pendingAction !== null}
                type="button"
                onClick={() => void mutateDocument(document, "scan")}
              >
                {pendingAction === `${document.id}:scan` ? "Queuing scan…" : "Scan or retry scan"}
              </button>
            ) : null}
            {(["CLEAN", "READY", "EXTRACTION_FAILED", "OCR_REQUIRED_UNSUPPORTED", "EXTRACTING"] as string[]).includes(
              document.status ?? ""
            ) ? (
              <button
                className="ui-button ui-button--secondary"
                disabled={pendingAction !== null}
                type="button"
                onClick={() => void mutateDocument(document, "extract")}
              >
                {pendingAction === `${document.id}:extract` ? "Queuing extraction…" : "Extract or re-extract"}
              </button>
            ) : null}
            {document.scanStatus === "CLEAN" ? (
              <a
                className="ui-button ui-button--secondary"
                href={`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}/download`}
              >
                Download clean original
              </a>
            ) : null}
            <button
              className="ui-button ui-button--danger"
              disabled={pendingAction !== null}
              type="button"
              onClick={() => void mutateDocument(document, "delete")}
            >
              {pendingAction === `${document.id}:delete` ? "Deleting…" : "Delete"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
