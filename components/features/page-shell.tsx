"use client";

import {
  Activity,
  Files,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  ScrollText,
  Settings,
  UserRoundCog,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  WorkbenchShell,
  type WorkbenchNavItem,
} from "@/components/workbench-shell";
import { StatusBadge } from "@/components/ui";

import type { ProjectRecord } from "./model";

const globalNavigation: readonly WorkbenchNavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/operations", label: "Operations", icon: Activity },
  { href: "/jobs", label: "Jobs", icon: ListTodo },
  { href: "/runs", label: "Runs", icon: Workflow },
  { href: "/documents", label: "Documents", icon: Files },
  { href: "/evaluations", label: "Evaluations", icon: FlaskConical },
  { href: "/audit", label: "Audit", icon: ScrollText },
  { href: "/sessions", label: "Sessions", icon: UserRoundCog },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface PageShellProps {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  aside?: ReactNode;
}

export function PageShell(props: PageShellProps) {
  return <WorkbenchShell {...props} navItems={globalNavigation} />;
}

interface ProjectPageShellProps extends Omit<PageShellProps, "eyebrow"> {
  project: ProjectRecord;
}

export function ProjectPageShell({ project, ...props }: ProjectPageShellProps) {
  return (
    <WorkbenchShell
      {...props}
      navItems={globalNavigation}
      project={{
        id: project.id,
        name: project.name,
        status: <StatusBadge status={project.status} />,
      }}
    />
  );
}
