"use client";

import {
  Activity,
  BookOpenCheck,
  Files,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  Menu,
  Settings,
  UserRoundCog,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  ProjectSubnav,
  type ProjectSubnavItem,
} from "@/components/ui/project-subnav";

export interface WorkbenchNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  exact?: boolean;
}

export interface WorkbenchProjectContext {
  id: string;
  name: string;
  status?: ReactNode;
}

export interface WorkbenchShellProps {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  aside?: ReactNode;
  navItems?: readonly WorkbenchNavItem[];
  project?: WorkbenchProjectContext;
  projectSubnavItems?: readonly ProjectSubnavItem[];
  footer?: ReactNode;
}

const defaultNavItems: readonly WorkbenchNavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/operations", label: "Operations", icon: Activity },
  { href: "/jobs", label: "Jobs", icon: ListTodo },
  { href: "/runs", label: "Runs", icon: Workflow },
  { href: "/documents", label: "Documents", icon: Files },
  { href: "/evaluations", label: "Evaluations", icon: FlaskConical },
  { href: "/sessions", label: "Sessions", icon: UserRoundCog },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isNavItemActive(pathname: string, item: WorkbenchNavItem) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

interface NavigationProps {
  items: readonly WorkbenchNavItem[];
  pathname: string;
  onNavigate?: () => void;
  drawer?: boolean;
}

function Navigation({ items, pathname, onNavigate, drawer = false }: NavigationProps) {
  return (
    <nav aria-label="Primary navigation" className="workbench-nav">
      <p className="workbench-nav__label">Workspace</p>
      <ul>
        {items.map((item, index) => {
          const Icon = item.icon;
          const active = isNavItemActive(pathname, item);

          return (
            <li key={item.href}>
              <Link
                aria-current={active ? "page" : undefined}
                className="workbench-nav__link"
                data-drawer-first={drawer && index === 0 ? "true" : undefined}
                href={item.href}
                onClick={onNavigate}
              >
                {Icon ? <Icon aria-hidden="true" /> : null}
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Brand() {
  return (
    <Link aria-label="AI Research Workbench dashboard" className="workbench-brand" href="/">
      <span aria-hidden="true" className="workbench-brand__mark">
        <BookOpenCheck />
      </span>
      <span>
        <strong>AI Research Workbench</strong>
        <small>Evidence-first operations</small>
      </span>
    </Link>
  );
}

export function WorkbenchShell({
  children,
  title,
  description,
  eyebrow = "Research operations",
  actions,
  aside,
  navItems = defaultNavItems,
  project,
  projectSubnavItems,
  footer,
}: WorkbenchShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    shellRef.current?.setAttribute("data-app-ready", "true");

    function closeDrawerForHistoryNavigation() {
      setDrawerOpen(false);
    }

    window.addEventListener("popstate", closeDrawerForHistoryNavigation);
    return () => window.removeEventListener("popstate", closeDrawerForHistoryNavigation);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstLink = drawerRef.current?.querySelector<HTMLElement>(
      '[data-drawer-first="true"]',
    );
    firstLink?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  function closeDrawer(restoreFocus = false) {
    setDrawerOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer(true);
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable.at(-1);

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div ref={shellRef} className="workbench-shell" data-app-ready="false">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="workbench-sidebar">
        <Brand />
        <Navigation items={navItems} pathname={pathname} />
        <div className="workbench-sidebar__footer">
          {footer ?? (
            <p>
              <strong>Human approval required</strong>
              <span>AI output stays reviewable and source-linked.</span>
            </p>
          )}
        </div>
      </aside>

      <div className="workbench-stage">
        <header className="mobile-header">
          <Brand />
          <button
            ref={menuButtonRef}
            aria-controls="mobile-navigation"
            aria-expanded={drawerOpen}
            aria-label="Open navigation"
            className="mobile-header__menu"
            type="button"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
        </header>

        <div className="mobile-drawer" hidden={!drawerOpen}>
          <button
            aria-label="Close navigation"
            className="mobile-drawer__backdrop"
            tabIndex={-1}
            type="button"
            onClick={() => closeDrawer()}
          />
          <div
            ref={drawerRef}
            aria-label="Main menu"
            aria-modal="true"
            className="mobile-drawer__panel"
            id="mobile-navigation"
            role="dialog"
            onKeyDown={handleDrawerKeyDown}
          >
            <div className="mobile-drawer__header">
              <Brand />
              <button
                aria-label="Close navigation"
                className="mobile-drawer__close"
                type="button"
                onClick={() => closeDrawer(true)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <Navigation
              drawer
              items={navItems}
              pathname={pathname}
              onNavigate={() => closeDrawer()}
            />
            <div className="mobile-drawer__footer">
              {footer ?? "Evidence stays attached to every material claim."}
            </div>
          </div>
        </div>

        <header className="workbench-topbar">
          <div className="workbench-topbar__copy">
            <div className="workbench-topbar__context">
              <span>{project ? project.name : eyebrow}</span>
              {project?.status ? <span>{project.status}</span> : null}
            </div>
            <h1>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="workbench-topbar__actions">{actions}</div> : null}
        </header>

        {project ? (
          <ProjectSubnav items={projectSubnavItems} projectId={project.id} />
        ) : null}

        <main className="workbench-main" id="main-content" tabIndex={-1}>
          <div className="workbench-content-layout" data-has-detail={Boolean(aside) || undefined}>
            <div className="workbench-content">{children}</div>
            {aside ? <div className="workbench-detail-rail">{aside}</div> : null}
          </div>
        </main>
      </div>
    </div>
  );
}
