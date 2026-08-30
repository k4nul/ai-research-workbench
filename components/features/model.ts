export interface ProjectRecord {
  id: string;
  name: string;
  client_name: string | null;
  core_question: string;
  background: string | null;
  purpose: string;
  audience: string;
  scope: string;
  exclusions: string | null;
  jurisdiction: string | null;
  research_date: string;
  source_max_age_days: number;
  deadline: string | null;
  deliverable_formats: string[];
  special_requirements: string | null;
  status: string;
  progress: number;
  approval_status: string;
  scope_approved_at?: string | null;
  plan_approved_at?: string | null;
  qa_passed_at?: string | null;
  approved_at?: string | null;
  delivered_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionRecord {
  id: string;
  parent_id: string | null;
  question: string;
  priority: string;
  completion_criteria: string;
  status: string;
  research_gap: string | null;
  gap_status: string;
  created_at: string;
  updated_at: string;
}

export interface PlanRecord {
  id: string;
  question_id: string;
  search_strategy: string;
  search_queries: string[];
  primary_source_types: string[];
  secondary_source_types: string[];
  comparison_targets: string[];
  expected_output: string;
  completion_condition: string;
  expected_risks: string[];
  research_gap: string | null;
  ai_suggested: boolean;
  human_approved: boolean;
  updated_at: string;
}

export interface SourceRecord {
  id: string;
  project_id: string;
  url: string | null;
  title: string;
  publisher: string | null;
  author: string | null;
  published_at: string | null;
  accessed_at: string;
  source_type: string;
  language: string;
  reliability_grade: string;
  freshness_status: string;
  usage_restrictions: string | null;
  ingestion_method: string;
  mime_type: string | null;
  content_summary: string | null;
  sanitized_content: string | null;
  duplicate_of_source_id: string | null;
  evidence_count?: number;
}

export interface EvidenceRecord {
  id: string;
  source_id: string;
  source_title?: string;
  summary: string;
  minimal_quote: string | null;
  original_location: string | null;
  page_or_section: string | null;
  confidence: string;
  verification_status: string;
  support_extent: "FULL" | "PARTIAL";
  created_at: string;
}

export interface EvidenceLink {
  evidenceId: string;
  summary?: string;
  quote?: string | null;
  relationship: string;
  sourceId: string;
  sourceTitle?: string;
  publisher?: string | null;
  reliability?: string;
  freshness?: string;
  supportExtent?: "FULL" | "PARTIAL";
}

export interface ClaimRecord {
  id: string;
  question_id: string | null;
  content: string;
  claim_type: string;
  importance: string;
  support_status: string;
  fact_or_inference: string;
  verification_possible: boolean;
  within_scope: boolean;
  include_in_report: boolean;
  resolution_notes: string | null;
  evidence_links?: EvidenceLink[];
  linked_evidence?: EvidenceLink[];
  created_at: string;
}

export interface FindingRecord {
  id: string;
  question_id: string | null;
  finding: string;
  importance: string;
  impact: string | null;
  limitations: string | null;
  can_inform_recommendation: boolean;
  claim_ids: string[];
  created_at: string;
}

export interface DeliverableRecord {
  id: string;
  title: string;
  version: number;
  approval_status: string;
  sections: ReportSectionValues;
  created_at: string;
  updated_at: string;
}

export interface ReportSectionValues {
  researchPurpose: string;
  executiveSummary: string;
  researchScope: string;
  methodology: string;
  keyFindings: string;
  detailedAnalysis: string;
  comparisonTable: string;
  risksAndLimitations: string;
  recommendations: string;
  references: string;
  appendix: string;
}

export interface QaFindingRecord {
  id: string;
  rule_code: string;
  severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";
  location: string;
  problem: string;
  remediation: string;
  resolution_status: string;
  created_at: string;
}

export interface AuditRecord {
  id: string;
  project_id: string | null;
  project_name: string | null;
  actor_type: string;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  created_at: string;
}

export interface ProjectBundle {
  project: ProjectRecord;
  questions: QuestionRecord[];
  plans: PlanRecord[];
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  claims: ClaimRecord[];
  findings: FindingRecord[];
  deliverables: DeliverableRecord[];
  qaFindings: QaFindingRecord[];
  auditEvents: AuditRecord[];
}

export interface DashboardData {
  metrics: {
    activeProjects: number;
    dueSoon: number;
    qaBlocked: number;
    awaitingApproval: number;
    openGaps: number;
    unsupportedClaims: number;
  };
  projects: ProjectRecord[];
  recentActivity: AuditRecord[];
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function calendarDate(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value ?? "").slice(0, 10);
}

function normalizeProject(value: unknown): ProjectRecord {
  const project = value as ProjectRecord;
  return {
    ...project,
    research_date: calendarDate(project.research_date),
    deadline: project.deadline ? calendarDate(project.deadline) : null,
    scope_approved_at: project.scope_approved_at
      ? timestamp(project.scope_approved_at)
      : null,
    plan_approved_at: project.plan_approved_at
      ? timestamp(project.plan_approved_at)
      : null,
    qa_passed_at: project.qa_passed_at ? timestamp(project.qa_passed_at) : null,
    approved_at: project.approved_at ? timestamp(project.approved_at) : null,
    delivered_at: project.delivered_at ? timestamp(project.delivered_at) : null,
    created_at: timestamp(project.created_at),
    updated_at: timestamp(project.updated_at),
  };
}

export function asProject(value: unknown): ProjectRecord {
  return normalizeProject(value);
}

export function asProjects(value: unknown): ProjectRecord[] {
  return (value as ProjectRecord[]).map(normalizeProject);
}

export function asBundle(value: unknown): ProjectBundle {
  const bundle = value as ProjectBundle;
  return { ...bundle, project: normalizeProject(bundle.project) };
}

export function asDashboard(value: unknown): DashboardData {
  const dashboard = value as DashboardData;
  return { ...dashboard, projects: dashboard.projects.map(normalizeProject) };
}

export function asRows<Row>(value: unknown): Row[] {
  return value as Row[];
}

export function asSourceDetail(value: unknown): {
  source: SourceRecord;
  evidence: EvidenceRecord[];
  claims: ClaimRecord[];
} {
  return value as {
    source: SourceRecord;
    evidence: EvidenceRecord[];
    claims: ClaimRecord[];
  };
}
