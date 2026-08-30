"use client";

import { X } from "lucide-react";
import { useId, type ReactNode } from "react";

interface DetailPanelProps {
  title: string;
  children: ReactNode;
  eyebrow?: string;
  description?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  sticky?: boolean;
}

export function DetailPanel({
  title,
  children,
  eyebrow,
  description,
  footer,
  onClose,
  closeLabel = "Close detail panel",
  sticky = true,
}: DetailPanelProps) {
  const headingId = useId();

  return (
    <aside
      aria-labelledby={headingId}
      className="detail-panel"
      data-sticky={sticky || undefined}
    >
      <header className="detail-panel__header">
        <div>
          {eyebrow ? <p className="detail-panel__eyebrow">{eyebrow}</p> : null}
          <h2 id={headingId}>{title}</h2>
          {description ? <p className="detail-panel__description">{description}</p> : null}
        </div>
        {onClose ? (
          <button
            aria-label={closeLabel}
            className="detail-panel__close"
            type="button"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="detail-panel__body">{children}</div>
      {footer ? <footer className="detail-panel__footer">{footer}</footer> : null}
    </aside>
  );
}
