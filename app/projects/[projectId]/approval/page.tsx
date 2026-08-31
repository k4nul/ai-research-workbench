import { Archive, CheckCircle2, Download, PackageCheck, Send } from "lucide-react";

import { ExportLink } from "@/components/features/export-link";
import { formatDateTime } from "@/components/features/format";
import { ApiActionButton } from "@/components/features/mutation-ui";
import { ProjectPageShell } from "@/components/features/page-shell";
import { loadProjectBundle } from "@/components/features/server-data";
import { ProgressBar, StatusBadge } from "@/components/ui";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

const exportFormats = ["markdown", "html", "pdf", "docx", "csv", "zip"] as const;
const requiredReportSections = [
  "researchPurpose",
  "executiveSummary",
  "researchScope",
  "methodology",
  "keyFindings",
  "detailedAnalysis",
  "risksAndLimitations",
  "recommendations",
  "references",
] as const;

export default async function ApprovalPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePageOperator();
  const { projectId } = await params;
  const bundle = await loadProjectBundle(projectId);
  const project = bundle.project;
  const unresolvedBlockers = bundle.qaFindings.filter((finding) => finding.severity === "BLOCKER" && finding.resolution_status !== "RESOLVED").length;
  const qaReady = Boolean(project.qa_passed_at) && unresolvedBlockers === 0;
  const currentReport = bundle.deliverables[0];
  const readiness = [
    { label: "approved scope", ready: Boolean(project.scope_approved_at) },
    {
      label: "approved plan for every question",
      ready: Boolean(project.plan_approved_at) && bundle.questions.length > 0 && bundle.questions.every((question) => bundle.plans.some((plan) => plan.question_id === question.id && plan.human_approved)),
    },
    {
      label: "completed questions or accepted gaps",
      ready: bundle.questions.length > 0 && bundle.questions.every((question) => question.status === "COMPLETE" || question.gap_status === "ACCEPTED" || question.gap_status === "RESOLVED"),
    },
    {
      label: "reportable supported claims",
      ready: bundle.claims.some((claim) => claim.include_in_report) && bundle.claims.filter((claim) => claim.include_in_report).every((claim) => claim.support_status !== "UNSUPPORTED" && claim.support_status !== "NOT_VERIFIABLE"),
    },
    { label: "findings linked to reportable supported claims", ready: bundle.findings.length > 0 && bundle.findings.every((finding) => finding.claim_ids.some((claimId) => bundle.claims.some((claim) => claim.id === claimId && claim.include_in_report && claim.support_status !== "UNSUPPORTED" && claim.support_status !== "NOT_VERIFIABLE"))) },
    { label: "all required report sections", ready: Boolean(currentReport) && requiredReportSections.every((section) => currentReport.sections[section]?.trim()) },
    { label: "fresh passing QA", ready: qaReady },
  ];
  const missingReadiness = readiness.filter((gate) => !gate.ready).map((gate) => gate.label);
  const workflowReady = missingReadiness.length === 0;
  const availableExportFormats = exportFormats.filter((format) => format === "zip" || project.deliverable_formats.includes(format.toLocaleUpperCase()));
  const pending = project.approval_status === "PENDING";
  const approved = project.approval_status === "APPROVED";
  return (
    <ProjectPageShell description="Package the evidence-backed deliverable, request review, record explicit human approval, and mark delivery." project={project} title="Approval & export">
      <div className="page-stack">
        <section className="section-card approval-overview">
          <div><p className="eyebrow">Current gate</p><div className="approval-overview__status"><StatusBadge status={project.approval_status} /><StatusBadge status={project.status} /></div></div>
          <ProgressBar label="Strict workflow evidence completed" tone={project.progress === 100 ? "success" : "default"} value={project.progress} />
          <dl className="definition-grid"><div><dt>QA pass</dt><dd>{project.qa_passed_at ? formatDateTime(project.qa_passed_at) : "Not recorded"}</dd></div><div><dt>Unresolved blockers</dt><dd>{unresolvedBlockers}</dd></div><div><dt>Human approval</dt><dd>{project.approved_at ? formatDateTime(project.approved_at) : "Not recorded"}</dd></div><div><dt>Delivery</dt><dd>{project.delivered_at ? formatDateTime(project.delivered_at) : "Not recorded"}</dd></div></dl>
          <div className={`notice ${workflowReady ? "notice--success" : "notice--danger"}`}><CheckCircle2 aria-hidden="true" /><p>{workflowReady ? "All workflow prerequisites are ready for human approval." : `Complete before requesting approval: ${missingReadiness.join(", ")}.`}</p></div>
        </section>

        <section className="section-card">
          <div className="section-heading"><div><h2>Export deliverables</h2><p>Downloads are generated from the current stored report. Persist a ZIP before marking delivery.</p></div></div>
          <div className="export-grid">{availableExportFormats.map((format) => <ExportLink className="export-link" href={`/api/projects/${encodeURIComponent(projectId)}/exports/${format}`} key={format}><span><Download aria-hidden="true" /><strong>{format.toLocaleUpperCase()}</strong></span><small>{format === "zip" ? "Final package required for delivery" : "Requested project format"}</small></ExportLink>)}</div>
        </section>

        <section className="section-card">
          <div className="section-heading"><div><h2>Human decision trail</h2><p>These actions update workflow state only. Nothing is emailed or delivered externally.</p></div></div>
          <ol className="approval-steps">
            <li data-complete={pending || approved || project.status === "DELIVERED"}><span className="approval-steps__icon"><Send aria-hidden="true" /></span><div><h3>1. Request approval</h3><p>Requires the complete evidence-first workflow and a fresh passing QA run.</p><ApiActionButton body={{ action: "request", confirmation: false }} disabled={!workflowReady || pending || approved || project.status === "DELIVERED"} endpoint={`/api/projects/${encodeURIComponent(projectId)}/approval`} label="Request approval" successMessage="Approval requested for human review." /></div></li>
            <li data-complete={approved || project.status === "DELIVERED"}><span className="approval-steps__icon"><CheckCircle2 aria-hidden="true" /></span><div><h3>2. Approve</h3><p>Available only after approval is requested. Confirmation records a human decision.</p><ApiActionButton body={{ action: "approve", confirmation: true }} confirmationLabel="I reviewed the current report, evidence, limitations, and QA state and approve this project." disabled={!pending} endpoint={`/api/projects/${encodeURIComponent(projectId)}/approval`} label="Approve project" requireConfirmation successMessage="Explicit human approval recorded." /></div></li>
            <li data-complete={project.status === "DELIVERED"}><span className="approval-steps__icon"><PackageCheck aria-hidden="true" /></span><div><h3>3. Mark delivered</h3><p>Requires approval and a persisted ZIP package. This records state; it does not contact a recipient.</p><ApiActionButton body={{ action: "deliver", confirmation: false }} disabled={!approved || project.status === "DELIVERED"} endpoint={`/api/projects/${encodeURIComponent(projectId)}/approval`} label="Mark delivered" successMessage="Project marked delivered." /></div></li>
          </ol>
          <div className="notice notice--info"><Archive aria-hidden="true" /><p>Export links remain available on mobile. Use the browser’s download controls to save or share files intentionally.</p></div>
        </section>
      </div>
    </ProjectPageShell>
  );
}
