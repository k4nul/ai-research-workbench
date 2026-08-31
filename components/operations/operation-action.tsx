"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { apiRequest, type MutationMessage } from "@/components/features/client-api";
import { MutationFeedback } from "@/components/features/mutation-ui";

export function OperationAction({
  endpoint,
  label,
  pendingLabel = "Working…",
  projectId,
  successMessage,
  dangerous = false,
  confirmationMessage,
  disabled = false
}: {
  endpoint: string;
  label: string;
  pendingLabel?: string;
  projectId: string | null;
  successMessage: string;
  dangerous?: boolean;
  confirmationMessage?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const pendingRequest = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function run() {
    if (
      dangerous &&
      !window.confirm(confirmationMessage ?? `${label}? This updates durable execution state.`)
    ) {
      return;
    }
    const fingerprint = JSON.stringify({ endpoint, projectId });
    const request =
      pendingRequest.current?.fingerprint === fingerprint
        ? pendingRequest.current
        : { fingerprint, idempotencyKey: crypto.randomUUID() };
    pendingRequest.current = request;
    setPending(true);
    setMessage(null);
    try {
      await apiRequest(endpoint, {
        method: "POST",
        headers: { "Idempotency-Key": request.idempotencyKey },
        body: JSON.stringify({ projectId })
      });
      if (pendingRequest.current === request) pendingRequest.current = null;
      setMessage({ tone: "success", text: successMessage });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The operation failed."
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-action">
      <button
        className={dangerous ? "ui-button ui-button--danger" : "ui-button ui-button--secondary"}
        disabled={disabled || pending}
        type="button"
        onClick={run}
      >
        {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : null}
        {pending ? pendingLabel : label}
      </button>
      <MutationFeedback message={message} />
    </div>
  );
}
