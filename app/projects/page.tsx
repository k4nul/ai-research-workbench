import Link from "next/link";

import { formatDate, formatDateTime } from "@/components/features/format";
import { asProjects } from "@/components/features/model";
import { PageShell } from "@/components/features/page-shell";
import { DataTable, EmptyState, ProgressBar, StatusBadge, type DataTableColumn } from "@/components/ui";
import { listProjects } from "@/lib/services/projects";

export const dynamic = "force-dynamic";

interface ProjectsPageProps {
  searchParams: Promise<{ q?: string; status?: string }>;
}

const statuses = ["", "INTAKE", "SCOPING", "PLANNING", "RESEARCHING", "SYNTHESIZING", "QA", "APPROVAL_REQUIRED", "APPROVED", "DELIVERED", "ARCHIVED"];

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const filters = await searchParams;
  const projects = asProjects(await listProjects({ queryText: filters.q?.trim() || undefined, status: filters.status || undefined }));
  const columns: DataTableColumn<(typeof projects)[number]>[] = [
    { id: "project", header: "Project", cell: (project) => <div className="table-primary"><Link href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</Link><span>{project.client_name ?? "No client"} · {project.core_question}</span></div> },
    { id: "status", header: "Workflow", cell: (project) => <div className="badge-stack"><StatusBadge status={project.status} /><StatusBadge showDot={false} status={project.approval_status}>{project.approval_status === "NOT_REQUESTED" ? "Approval not requested" : undefined}</StatusBadge></div> },
    { id: "progress", header: "Evidence progress", cell: (project) => <ProgressBar compact label={`${project.name} evidence progress`} value={project.progress} /> },
    { id: "asof", header: "As of", cell: (project) => formatDate(project.research_date) },
    { id: "deadline", header: "Deadline", cell: (project) => formatDate(project.deadline) },
    { id: "updated", header: "Updated", cell: (project) => formatDateTime(project.updated_at) },
  ];
  const hasFilters = Boolean(filters.q || filters.status);

  return (
    <PageShell actions={<Link className="ui-link-button" href="/projects/new">New project</Link>} description="Find, review, and resume research work by workflow state." title="Projects">
      <div className="page-stack">
        <form aria-label="Project filters" className="filter-toolbar" method="get">
          <div className="filter-toolbar__controls">
            <label className="filter-search"><span className="sr-only">Search projects</span><input defaultValue={filters.q ?? ""} name="q" placeholder="Search name or core question" type="search" /></label>
            <div className="filter-toolbar__filters"><label className="sr-only" htmlFor="project-status">Project status</label><select defaultValue={filters.status ?? ""} id="project-status" name="status">{statuses.map((status) => <option key={status || "all"} value={status}>{status ? status.replaceAll("_", " ") : "All statuses"}</option>)}</select></div>
            <button className="ui-button ui-button--secondary" type="submit">Apply filters</button>
            {hasFilters ? <Link className="filter-toolbar__clear" href="/projects">Clear filters</Link> : null}
          </div>
          <div className="filter-toolbar__meta"><span className="filter-toolbar__summary">{projects.length} matching project{projects.length === 1 ? "" : "s"}</span></div>
        </form>
        <section className="section-card section-card--flush">
          <DataTable caption="Research projects" columns={columns} emptyState={<EmptyState compact title={hasFilters ? "No matching projects" : "No projects yet"} description={hasFilters ? "Change or clear the filters to broaden this view." : "Start with a quick brief or detailed intake."} action={hasFilters ? <Link className="ui-link-button ui-link-button--secondary" href="/projects">Clear filters</Link> : <Link className="ui-link-button" href="/projects/new">Create project</Link>} />} getRowKey={(project) => project.id} rows={projects} />
        </section>
      </div>
    </PageShell>
  );
}
