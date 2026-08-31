"use client";

import { type MouseEvent, type ReactNode, useRef, useState } from "react";

import {
  apiRequest,
  type MutationMessage
} from "@/components/features/client-api";
import { MutationFeedback } from "@/components/features/mutation-ui";

export function ExportLink({
  children,
  className,
  href
}: {
  children: ReactNode;
  className?: string;
  href: string;
}) {
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MutationMessage | null>(null);

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage({ tone: "success", text: "Queueing export…" });
    try {
      await apiRequest(href, { method: "POST" });
      setMessage({ tone: "success", text: "Export queued. Preparing download…" });
      const response = await fetch(href, {
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw new Error(`Export download failed (${response.status}).`);
      }

      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      const disposition = response.headers.get("content-disposition");
      const filename = disposition?.match(/filename="([^"]+)"/)?.[1];
      if (filename) anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setMessage({ tone: "success", text: "Export queued and download started." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The export could not be prepared."
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="export-action">
      <a
        aria-busy={pending}
        aria-disabled={pending}
        className={className}
        href={href}
        onClick={download}
      >
        {children}
      </a>
      <MutationFeedback message={message} />
    </div>
  );
}
