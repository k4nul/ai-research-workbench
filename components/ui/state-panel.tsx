"use client";

import { AlertTriangle, Inbox, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

interface StatePanelProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function LoadingState({
  title = "Loading",
  description = "Retrieving the latest workspace data.",
  compact = false,
}: Partial<Omit<StatePanelProps, "action">>) {
  return (
    <section
      aria-live="polite"
      aria-busy="true"
      className="state-panel"
      data-compact={compact || undefined}
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="state-panel__icon state-panel__spinner" />
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: StatePanelProps) {
  return (
    <section className="state-panel" data-compact={compact || undefined}>
      <Inbox aria-hidden="true" className="state-panel__icon" />
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
        {action ? <div className="state-panel__action">{action}</div> : null}
      </div>
    </section>
  );
}

interface ErrorStateProps extends Omit<StatePanelProps, "action"> {
  action?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title,
  description,
  action,
  onRetry,
  retryLabel = "Try again",
  compact = false,
}: ErrorStateProps) {
  return (
    <section
      className="state-panel state-panel--error"
      data-compact={compact || undefined}
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="state-panel__icon" />
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
        {onRetry || action ? (
          <div className="state-panel__action">
            {onRetry ? (
              <button className="ui-button ui-button--secondary" type="button" onClick={onRetry}>
                <RotateCcw aria-hidden="true" />
                {retryLabel}
              </button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
    </section>
  );
}
