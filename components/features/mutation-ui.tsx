"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiRequest, type MutationMessage } from "./client-api";

export function MutationFeedback({ message }: { message: MutationMessage | null }) {
  if (!message) return null;
  return (
    <p
      aria-live="polite"
      className="mutation-feedback"
      data-tone={message.tone}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.text}
    </p>
  );
}

interface ApiActionButtonProps {
  endpoint: string;
  body?: unknown;
  label: string;
  pendingLabel?: string;
  successMessage: string;
  method?: "POST" | "PATCH" | "PUT";
  className?: string;
  requireConfirmation?: boolean;
  confirmationLabel?: string;
  disabled?: boolean;
}

export function ApiActionButton({
  endpoint,
  body,
  label,
  pendingLabel = "Working…",
  successMessage,
  method = "POST",
  className = "ui-button",
  requireConfirmation = false,
  confirmationLabel = "I confirm this human decision.",
  disabled = false,
}: ApiActionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function run() {
    setPending(true);
    setMessage(null);
    try {
      await apiRequest(endpoint, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      setMessage({ tone: "success", text: successMessage });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The action failed.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-action">
      {requireConfirmation ? (
        <label className="check-field">
          <input
            checked={confirmed}
            type="checkbox"
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />
          <span>{confirmationLabel}</span>
        </label>
      ) : null}
      <button
        className={className}
        disabled={disabled || pending || (requireConfirmation && !confirmed)}
        type="button"
        onClick={run}
      >
        {pending ? <LoaderCircle aria-hidden="true" className="spin" /> : null}
        {message?.tone === "success" && !pending ? (
          <CheckCircle2 aria-hidden="true" />
        ) : null}
        {pending ? pendingLabel : label}
      </button>
      <MutationFeedback message={message} />
    </div>
  );
}
