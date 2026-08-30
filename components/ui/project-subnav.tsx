"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface ProjectSubnavItem {
  href: string;
  label: string;
  exact?: boolean;
}

interface ProjectSubnavProps {
  projectId: string;
  items?: readonly ProjectSubnavItem[];
  label?: string;
}

export function getDefaultProjectSubnav(projectId: string): ProjectSubnavItem[] {
  const root = `/projects/${encodeURIComponent(projectId)}`;

  return [
    { href: root, label: "Overview", exact: true },
    { href: `${root}/scope`, label: "Scope" },
    { href: `${root}/plan`, label: "Plan" },
    { href: `${root}/sources`, label: "Sources" },
    { href: `${root}/ledger`, label: "Claims & evidence" },
    { href: `${root}/findings`, label: "Findings" },
    { href: `${root}/report`, label: "Report" },
    { href: `${root}/qa`, label: "QA" },
    { href: `${root}/approval`, label: "Approval & export" },
  ];
}

function isItemActive(pathname: string, item: ProjectSubnavItem) {
  return item.exact ? pathname === item.href : pathname.startsWith(`${item.href}/`) || pathname === item.href;
}

export function ProjectSubnav({
  projectId,
  items = getDefaultProjectSubnav(projectId),
  label = "Project sections",
}: ProjectSubnavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="project-subnav">
      <div className="project-subnav__scroll">
        {items.map((item) => {
          const active = isItemActive(pathname, item);

          return (
            <Link
              aria-current={active ? "page" : undefined}
              className="project-subnav__link"
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
