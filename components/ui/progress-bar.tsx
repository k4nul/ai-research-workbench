import type { CSSProperties } from "react";

interface ProgressBarProps {
  value: number;
  max?: number;
  label: string;
  showValue?: boolean;
  tone?: "default" | "success" | "warning" | "danger";
  compact?: boolean;
}

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = true,
  tone = "default",
  compact = false,
}: ProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  const percentage = (safeValue / safeMax) * 100;
  const style = { "--progress-value": `${percentage}%` } as CSSProperties;

  return (
    <div className="progress-block" data-compact={compact || undefined} data-tone={tone}>
      <div className="progress-block__label">
        <span>{label}</span>
        {showValue ? <strong>{Math.round(percentage)}%</strong> : null}
      </div>
      <div
        aria-label={label}
        aria-valuemax={safeMax}
        aria-valuemin={0}
        aria-valuenow={safeValue}
        className="progress-track"
        role="progressbar"
        style={style}
      >
        <span className="progress-track__fill" />
      </div>
    </div>
  );
}
