import Link from "next/link";
import type { ReactNode } from "react";

export type KpiTone = "neutral" | "info" | "success" | "warning" | "danger";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  href?: string;
  tone?: KpiTone;
}

function CardContents({
  label,
  value,
  detail,
  icon,
}: Omit<KpiCardProps, "href" | "tone">) {
  return (
    <>
      <div className="kpi-card__header">
        <span className="kpi-card__label">{label}</span>
        {icon ? (
          <span aria-hidden="true" className="kpi-card__icon">
            {icon}
          </span>
        ) : null}
      </div>
      <strong className="kpi-card__value">{value}</strong>
      {detail ? <span className="kpi-card__detail">{detail}</span> : null}
    </>
  );
}

export function KpiCard({ tone = "neutral", href, ...content }: KpiCardProps) {
  const className = "kpi-card";

  if (href) {
    return (
      <Link className={className} data-tone={tone} href={href}>
        <CardContents {...content} />
      </Link>
    );
  }

  return (
    <article className={className} data-tone={tone}>
      <CardContents {...content} />
    </article>
  );
}
