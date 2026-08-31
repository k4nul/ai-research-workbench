"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { apiRequest, type MutationMessage } from "@/components/features/client-api";
import { MutationFeedback } from "@/components/features/mutation-ui";

type ProjectOption = { id: string; name: string; status: string };

function createdRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("run" in value)) return null;
  const run = value.run;
  return run && typeof run === "object" && "id" in run && typeof run.id === "string"
    ? run.id
    : null;
}

export function RunCreateForm({ projects }: { projects: readonly ProjectOption[] }) {
  const router = useRouter();
  const pendingRequest = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const body = {
      projectId: String(form.get("projectId") ?? ""),
      mode: String(form.get("mode") ?? "")
    };
    const fingerprint = JSON.stringify(body);
    const request =
      pendingRequest.current?.fingerprint === fingerprint
        ? pendingRequest.current
        : { fingerprint, idempotencyKey: crypto.randomUUID() };
    pendingRequest.current = request;
    try {
      const result = await apiRequest("/api/runs", {
        method: "POST",
        headers: { "Idempotency-Key": request.idempotencyKey },
        body: JSON.stringify(body)
      });
      const runId = createdRunId(result);
      if (!runId) throw new Error("The run response did not include an identifier.");
      if (pendingRequest.current === request) pendingRequest.current = null;
      router.push(`/runs/${encodeURIComponent(runId)}`);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The run could not be created."
      });
      setPending(false);
    }
  }

  return (
    <form className="compact-form" onSubmit={submit}>
      <label className="field">
        <span>Approved project</span>
        <select className="ui-select" disabled={projects.length === 0} name="projectId" required>
          {projects.length === 0 ? <option value="">No projects available</option> : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} · {project.status}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Execution mode</span>
        <select className="ui-select" defaultValue="ORCHESTRATED" name="mode">
          <option value="ORCHESTRATED">Orchestrated</option>
          <option value="ASSISTED">Assisted</option>
          <option value="DRAFT_ONLY">Draft only</option>
        </select>
      </label>
      <button className="ui-button" disabled={pending || projects.length === 0} type="submit">
        {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Play aria-hidden="true" />}
        {pending ? "Creating…" : "Create run"}
      </button>
      <MutationFeedback message={message} />
    </form>
  );
}
