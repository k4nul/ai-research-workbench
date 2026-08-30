import "dotenv/config";
import type { PoolClient } from "pg";
import { getPool } from "../lib/db";

type SeedValue = string | number | boolean | null | string[] | Record<string, unknown>;

async function insert(
  client: PoolClient,
  table: string,
  row: Record<string, SeedValue>
): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => {
    const value = row[column];
    if (Array.isArray(value)) {
      return value;
    }
    if (value !== null && typeof value === "object") {
      return JSON.stringify(value);
    }
    return value;
  });
  const placeholders = columns.map((_, index) => "$" + (index + 1));
  const sql =
    "INSERT INTO " +
    table +
    " (" +
    columns.join(", ") +
    ") VALUES (" +
    placeholders.join(", ") +
    ") ON CONFLICT (id) DO NOTHING";
  await client.query(sql, values);
}

const ids = {
  workspace: "workspace-demo",
  client: "client-demo",
  project: "project-demo",
  deliverable: "deliverable-demo-v2"
} as const;

const questions = [
  {
    id: "question-demo-1",
    question: "Which workflow costs and delays are most material today?",
    priority: "CRITICAL",
    status: "COMPLETE",
    completion_criteria: "Triangulate cost and cycle-time ranges from at least two independent fixture sources.",
    research_gap: null,
    gap_status: "NONE"
  },
  {
    id: "question-demo-2",
    question: "What operational benefits could a managed research workbench provide?",
    priority: "HIGH",
    status: "COMPLETE",
    completion_criteria: "Document measured and reported benefits separately, with limitations.",
    research_gap: null,
    gap_status: "NONE"
  },
  {
    id: "question-demo-3",
    question: "Which security and governance controls are required before adoption?",
    priority: "CRITICAL",
    status: "COMPLETE",
    completion_criteria: "Map recommended controls to primary guidance and record residual risks.",
    research_gap: null,
    gap_status: "NONE"
  },
  {
    id: "question-demo-4",
    question: "How does adoption affect teams with fewer than five researchers?",
    priority: "MEDIUM",
    status: "BLOCKED",
    completion_criteria: "Find a representative small-team benchmark or explicitly accept the evidence gap.",
    research_gap: "No representative fixture benchmark isolates teams with fewer than five researchers.",
    gap_status: "ACCEPTED"
  }
] as const;

const sources = [
  {
    id: "source-demo-1",
    url: "https://example.com/fixtures/workflow-baseline-2026",
    title: "[SAMPLE] Research workflow baseline 2026",
    publisher: "Sample Operations Institute",
    author: "Fixture Analytics Unit",
    published_at: "2026-05-15",
    source_type: "BENCHMARK",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-001",
    content_summary: "Synthetic benchmark of manual evidence-handling time and review delay.",
    sanitized_content: "Fixture data: manual evidence handling represents 31 percent of project effort across the synthetic cohort."
  },
  {
    id: "source-demo-2",
    url: "https://example.org/fixtures/independent-adoption-study",
    title: "[SAMPLE] Independent workbench adoption study",
    publisher: "Example Research Cooperative",
    author: "Sample Methods Group",
    published_at: "2026-04-03",
    source_type: "STUDY",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-002",
    content_summary: "Synthetic controlled comparison of research cycle time.",
    sanitized_content: "Fixture data: teams using a structured evidence ledger completed review 18 percent faster in the sample."
  },
  {
    id: "source-demo-3",
    url: "https://www.iana.org/help/example-domains",
    title: "[SAMPLE] Governance controls for assisted research",
    publisher: "Sample Digital Governance Office",
    author: "Fixture Standards Board",
    published_at: "2025-11-20",
    source_type: "PRIMARY_GUIDANCE",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-003",
    content_summary: "Synthetic primary guidance requiring traceability and human approval.",
    sanitized_content: "Fixture guidance: high-impact external research outputs require traceable evidence and named human approval."
  },
  {
    id: "source-demo-4",
    url: "https://example.net/fixtures/midmarket-case-study",
    title: "[SAMPLE] Mid-market research team case study",
    publisher: "Northstar Example Group",
    author: "Demo Customer Office",
    published_at: "2025-09-08",
    source_type: "CASE_STUDY",
    reliability_grade: "B",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-004",
    content_summary: "Synthetic case study reporting faster evidence review after adoption.",
    sanitized_content: "Fixture case: review rework fell from 14 hours to 9 hours per report after a structured ledger was introduced."
  },
  {
    id: "source-demo-5",
    url: "https://example.com/fixtures/market-note-2021",
    title: "[SAMPLE] Legacy research tooling market note",
    publisher: "Sample Operations Institute",
    author: "Archive Team",
    published_at: "2021-02-10",
    source_type: "MARKET_NOTE",
    reliability_grade: "B",
    freshness_status: "OUTDATED",
    content_hash: "fixture-hash-005",
    content_summary: "Intentionally outdated fixture retained for audit and freshness testing.",
    sanitized_content: "Fixture archive: early research automation tools required manual citation reconciliation."
  },
  {
    id: "source-demo-6",
    url: "https://example.edu/fixtures/researcher-survey",
    title: "[SAMPLE] Researcher trust and adoption survey",
    publisher: "Example University Lab",
    author: "Synthetic Survey Team",
    published_at: "2026-02-28",
    source_type: "SURVEY",
    reliability_grade: "B",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-006",
    content_summary: "Synthetic survey finding slower first-month throughput, in tension with the adoption study.",
    sanitized_content: "Fixture survey: first-month throughput declined 7 percent while teams learned evidence-ledger practices."
  },
  {
    id: "source-demo-7",
    url: "https://example.gov/fixtures/security-standard",
    title: "[SAMPLE] Secure handling standard for external content",
    publisher: "Sample Cyber Safety Agency",
    author: "Fixture Security Directorate",
    published_at: "2024-12-12",
    source_type: "STANDARD",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-007",
    content_summary: "Synthetic security standard covering untrusted external content.",
    sanitized_content: "Fixture standard: retrieved content must be treated as untrusted data, never as operator instructions."
  },
  {
    id: "source-demo-8",
    url: "https://example.io/fixtures/cost-methodology",
    title: "[SAMPLE] Total-cost comparison methodology",
    publisher: "Open Example Methods",
    author: "Demo Economics Team",
    published_at: "2026-06-01",
    source_type: "METHODOLOGY",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-008",
    content_summary: "Synthetic methodology defining a three-year cost comparison.",
    sanitized_content: "Fixture method: include implementation, subscription, training, review, and migration costs over three years."
  },
  {
    id: "source-demo-9",
    url: "https://example.com/fixtures/workflow-baseline-2026-copy",
    title: "[SAMPLE] Duplicate copy of workflow baseline",
    publisher: "Sample Operations Institute",
    author: "Fixture Analytics Unit",
    published_at: "2026-05-15",
    source_type: "BENCHMARK",
    reliability_grade: "A",
    freshness_status: "CURRENT",
    content_hash: "fixture-hash-001",
    content_summary: "Intentionally duplicated fixture excluded from the final report.",
    sanitized_content: "Fixture duplicate retained to demonstrate duplicate-source QA."
  }
] as const;

const evidenceItems = [
  ["evidence-demo-1", "source-demo-1", "Manual evidence handling is a material workload component.", "31 percent of project effort", "Results / workflow allocation", "HIGH"],
  ["evidence-demo-2", "source-demo-2", "Structured ledgers reduced review cycle time in the synthetic study.", "18 percent faster", "Findings / cycle time", "HIGH"],
  ["evidence-demo-3", "source-demo-3", "Traceability and named human approval are required controls.", "traceable evidence and named human approval", "Control 4.2", "HIGH"],
  ["evidence-demo-4", "source-demo-4", "A synthetic case reported lower review rework.", "fell from 14 hours to 9 hours", "Outcomes", "MEDIUM"],
  ["evidence-demo-5", "source-demo-5", "Older tools needed manual citation reconciliation.", "required manual citation reconciliation", "Archive summary", "LOW"],
  ["evidence-demo-6", "source-demo-6", "Initial adoption can temporarily reduce throughput.", "declined 7 percent", "Survey result 3", "MEDIUM"],
  ["evidence-demo-7", "source-demo-7", "External content must remain an untrusted data input.", "treated as untrusted data", "Section 2.1", "HIGH"],
  ["evidence-demo-8", "source-demo-8", "A fair comparison includes five three-year cost categories.", "implementation, subscription, training, review, and migration", "Method / cost boundary", "HIGH"],
  ["evidence-demo-9", "source-demo-1", "The baseline is a synthetic multi-team aggregate, not a small-team benchmark.", "across the synthetic cohort", "Methods / cohort", "MEDIUM"],
  ["evidence-demo-10", "source-demo-2", "The measured result applies after onboarding.", "completed review 18 percent faster", "Limitations", "MEDIUM"],
  ["evidence-demo-11", "source-demo-3", "External delivery remains a human decision.", "named human approval", "Control 4.2", "HIGH"],
  ["evidence-demo-12", "source-demo-6", "The adoption survey conflicts with immediate productivity claims.", "first-month throughput declined", "Survey result 3", "MEDIUM"]
] as const;

const claims = [
  ["claim-demo-1", "question-demo-1", "Manual evidence handling represents 31% of project effort in the synthetic baseline.", "FACT", "CRITICAL", "SUPPORTED", "FACT"],
  ["claim-demo-2", "question-demo-2", "A structured evidence ledger reduced review cycle time by 18% in the synthetic adoption study.", "FACT", "HIGH", "CONTESTED", "FACT"],
  ["claim-demo-3", "question-demo-3", "Human approval should remain mandatory for external delivery.", "RECOMMENDATION", "CRITICAL", "SUPPORTED", "INFERENCE"],
  ["claim-demo-4", "question-demo-2", "A case team reduced review rework from 14 to 9 hours per report.", "FACT", "MEDIUM", "SUPPORTED", "FACT"],
  ["claim-demo-5", "question-demo-2", "The first month of adoption can temporarily reduce throughput.", "FACT", "HIGH", "SUPPORTED", "FACT"],
  ["claim-demo-6", "question-demo-3", "Retrieved web content must be handled as untrusted data.", "FACT", "CRITICAL", "SUPPORTED", "FACT"],
  ["claim-demo-7", "question-demo-1", "Three-year comparisons should include implementation, subscription, training, review, and migration costs.", "RECOMMENDATION", "HIGH", "SUPPORTED", "INFERENCE"],
  ["claim-demo-8", "question-demo-4", "The available fixture evidence cannot establish outcomes for teams under five researchers.", "INTERPRETATION", "HIGH", "SUPPORTED", "INFERENCE"],
  ["claim-demo-9", "question-demo-2", "Benefits are more credible after onboarding than during the first month.", "INFERENCE", "MEDIUM", "SUPPORTED", "INFERENCE"],
  ["claim-demo-10", "question-demo-3", "Traceable evidence is a prerequisite for high-impact research outputs.", "FACT", "CRITICAL", "SUPPORTED", "FACT"],
  ["claim-demo-11", "question-demo-1", "Legacy 2021 market assumptions should not drive the current decision.", "RECOMMENDATION", "MEDIUM", "OUTDATED", "INFERENCE"],
  ["claim-demo-12", "question-demo-2", "Adoption produces immediate productivity gains for every team.", "FACT", "LOW", "UNSUPPORTED", "FACT"]
] as const;

const claimEvidence = [
  ["claim-demo-1", "evidence-demo-1", "SUPPORTS"],
  ["claim-demo-2", "evidence-demo-2", "SUPPORTS"],
  ["claim-demo-2", "evidence-demo-12", "REFUTES"],
  ["claim-demo-3", "evidence-demo-3", "SUPPORTS"],
  ["claim-demo-3", "evidence-demo-11", "SUPPORTS"],
  ["claim-demo-4", "evidence-demo-4", "SUPPORTS"],
  ["claim-demo-5", "evidence-demo-6", "SUPPORTS"],
  ["claim-demo-6", "evidence-demo-7", "SUPPORTS"],
  ["claim-demo-7", "evidence-demo-8", "SUPPORTS"],
  ["claim-demo-8", "evidence-demo-9", "SUPPORTS"],
  ["claim-demo-9", "evidence-demo-10", "SUPPORTS"],
  ["claim-demo-9", "evidence-demo-12", "SUPPORTS"],
  ["claim-demo-10", "evidence-demo-3", "SUPPORTS"],
  ["claim-demo-11", "evidence-demo-5", "CONTEXT"]
] as const;

async function seed(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insert(client, "workspaces", {
      id: ids.workspace,
      name: "Sample Research Studio",
      default_research_language: "en",
      default_report_language: "en",
      default_citation_style: "APA",
      default_quality_standard: {
        minimumIndependentSources: 2,
        blockerFreeApproval: true,
        sampleDataOnly: true
      }
    });
    await insert(client, "clients", {
      id: ids.client,
      workspace_id: ids.workspace,
      organization_name: "[SAMPLE] Meridian Advisory",
      contact_name: "Demo reviewer",
      contact_info: { email: "demo@example.invalid" },
      internal_notes: "Synthetic fixture client. Never use as real customer data.",
      security_classification: "INTERNAL",
      is_active: true
    });
    await insert(client, "research_projects", {
      id: ids.project,
      workspace_id: ids.workspace,
      client_id: ids.client,
      name: "[SAMPLE] Research workbench adoption feasibility",
      core_question: "Should a small advisory team adopt an evidence-first AI research workbench?",
      background: "Synthetic demonstration brief for the API-key-free workflow.",
      purpose: "Evaluate operational value, limitations, governance, and a staged adoption path.",
      audience: "Operations lead and research director",
      scope: "Synthetic workflow benchmarks, governance controls, adoption risks, and three-year cost method.",
      exclusions: "Vendor procurement, legal advice, and claims about real organizations.",
      jurisdiction: "Sample multi-region context",
      research_date: "2026-08-15",
      source_max_age_days: 730,
      deadline: "2026-09-05",
      deliverable_formats: ["MARKDOWN", "HTML", "PDF", "DOCX", "ZIP"],
      special_requirements: "Every fixture fact must be cited; sample status must be visible.",
      status: "APPROVAL_REQUIRED",
      progress: 75,
      approval_status: "PENDING",
      scope_approved_at: "2026-08-16T09:00:00Z",
      plan_approved_at: "2026-08-16T10:00:00Z",
      qa_passed_at: "2026-08-20T14:00:00Z",
      is_sample: true
    });

    for (const question of questions) {
      await insert(client, "research_questions", {
        id: question.id,
        project_id: ids.project,
        parent_id: null,
        question: question.question,
        priority: question.priority,
        status: question.status,
        completion_criteria: question.completion_criteria,
        research_gap: question.research_gap,
        gap_status: question.gap_status
      });
      await insert(client, "research_plans", {
        id: "plan-" + question.id,
        project_id: ids.project,
        question_id: question.id,
        search_strategy: "Use fixture primary guidance first, then triangulate with independent synthetic sources.",
        search_queries: ["sample evidence ledger benchmark", "sample research governance controls"],
        primary_source_types: ["PRIMARY_GUIDANCE", "STANDARD", "METHODOLOGY"],
        secondary_source_types: ["STUDY", "SURVEY", "CASE_STUDY"],
        comparison_targets: ["manual workflow", "evidence-first workflow"],
        expected_output: "Cited answer with limitations and explicit gaps.",
        assigned_stage: "RESEARCHING",
        completion_condition: question.completion_criteria,
        expected_risks: ["fixture evidence is not a market fact", "small-team evidence gap"],
        research_gap: question.research_gap,
        ai_suggested: true,
        human_approved: true,
        approved_at: "2026-08-16T10:00:00Z"
      });
    }

    for (const source of sources) {
      await insert(client, "sources", {
        ...source,
        project_id: ids.project,
        reused_from_source_id: null,
        accessed_at: "2026-08-18T12:00:00Z",
        original_status: "AVAILABLE",
        language: "en",
        duplicate_of_source_id: source.id === "source-demo-9" ? "source-demo-1" : null,
        usage_restrictions: "Synthetic fixture; demonstration use only.",
        ingestion_method: "IMPORT",
        mime_type: "text/html",
        prompt_injection_flag: false,
        fetch_metadata: {
          fixture: true,
          userAgent: "ai-research-workbench-demo",
          accessedAt: "2026-08-18T12:00:00Z"
        }
      });
    }

    for (const item of evidenceItems) {
      await insert(client, "evidence", {
        id: item[0],
        source_id: item[1],
        summary: item[2],
        minimal_quote: item[3],
        original_location: item[4],
        page_or_section: item[4],
        confidence: item[5],
        verification_status: "VERIFIED"
      });
    }

    for (const claim of claims) {
      await insert(client, "claims", {
        id: claim[0],
        project_id: ids.project,
        question_id: claim[1],
        content: claim[2],
        claim_type: claim[3],
        importance: claim[4],
        support_status: claim[5],
        fact_or_inference: claim[6],
        include_in_report: !["claim-demo-11", "claim-demo-12"].includes(claim[0]),
        resolution_notes:
          claim[0] === "claim-demo-2"
            ? "The report separates post-onboarding gains from first-month learning costs."
            : claim[0] === "claim-demo-12"
              ? "Rejected after conflict review; excluded from report."
              : null
      });
    }

    for (const link of claimEvidence) {
      await client.query(
        "INSERT INTO claim_evidence (claim_id, evidence_id, relationship) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [...link]
      );
    }

    const findingRows = [
      ["finding-demo-1", "question-demo-1", "Evidence handling is the clearest synthetic efficiency opportunity.", "HIGH", "Prioritize ledger workflow before generative drafting.", "The benchmark is synthetic.", true],
      ["finding-demo-2", "question-demo-2", "Benefits appear after onboarding and are not immediate for every team.", "HIGH", "Use a staged pilot with a learning-period baseline.", "Study and survey use different synthetic cohorts.", true],
      ["finding-demo-3", "question-demo-3", "Traceability and human approval are non-negotiable controls.", "CRITICAL", "Block delivery while unsupported claims or QA blockers remain.", "Fixture guidance is illustrative, not legal advice.", true],
      ["finding-demo-4", "question-demo-4", "The small-team evidence gap remains accepted and visible.", "MEDIUM", "Collect pilot evidence before broad rollout.", "No representative under-five-person benchmark.", false]
    ] as const;
    for (const finding of findingRows) {
      await insert(client, "findings", {
        id: finding[0],
        project_id: ids.project,
        question_id: finding[1],
        finding: finding[2],
        importance: finding[3],
        impact: finding[4],
        limitations: finding[5],
        can_inform_recommendation: finding[6]
      });
    }
    const findingLinks = [
      ["finding-demo-1", "claim-demo-1"],
      ["finding-demo-2", "claim-demo-2"],
      ["finding-demo-2", "claim-demo-5"],
      ["finding-demo-3", "claim-demo-3"],
      ["finding-demo-3", "claim-demo-6"],
      ["finding-demo-4", "claim-demo-8"]
    ] as const;
    for (const link of findingLinks) {
      await client.query(
        "INSERT INTO finding_claims (finding_id, claim_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [...link]
      );
    }

    const sections = {
      researchPurpose: "Evaluate whether an evidence-first workbench is operationally viable for a small advisory team.",
      executiveSummary: "The synthetic evidence supports a staged pilot focused on evidence traceability. Reported efficiency gains appear after onboarding, while first-month throughput can fall. Human approval and blocker-free QA remain mandatory.",
      researchScope: "Synthetic workflow, adoption, governance, and three-year cost-method fixtures. No real company or market claim is made.",
      methodology: "We decomposed the brief into four questions, reviewed nine fixture sources, extracted minimal evidence, linked twelve claims, reconciled one conflict, and retained one accepted gap.",
      keyFindings: "Evidence handling is the largest synthetic workload opportunity. Benefits are plausible after onboarding. Governance controls determine whether assisted research is safe to deliver.",
      detailedAnalysis: "The 18% post-onboarding cycle-time result [source-demo-2] conflicts with a 7% first-month decline [source-demo-6]. The difference is handled as a time-horizon effect, not hidden. The 2021 market note [source-demo-5] is retained for audit but excluded from current recommendations.",
      comparisonTable: "Manual workflow | fragmented evidence | slower review\nEvidence-first pilot | traceable claims | onboarding cost\nScaled workflow | measurable controls | requires pilot proof",
      risksAndLimitations: "All values are synthetic fixtures. The under-five-person team evidence gap is accepted. Case studies are weaker than primary guidance. No legal or procurement conclusion is offered.",
      recommendations: "Run a bounded pilot; require source IDs for generated claims; review conflicts explicitly; measure first-month and post-onboarding results separately; preserve human approval for delivery.",
      references: "[source-demo-1] through [source-demo-8]. Source 9 is a known duplicate and excluded.",
      appendix: "Fixture label: SAMPLE DATA. Research date: 2026-08-15. Maximum source age: 730 days."
    };
    await insert(client, "deliverables", {
      id: ids.deliverable,
      project_id: ids.project,
      version: 2,
      title: "[SAMPLE] Evidence-first research workbench feasibility",
      sections,
      generated_at: "2026-08-20T13:30:00Z",
      approval_status: "REVIEW",
      export_files: []
    });
    await insert(client, "deliverable_revisions", {
      id: "revision-demo-1",
      deliverable_id: ids.deliverable,
      actor_type: "AI",
      changed_sections: Object.keys(sections),
      previous_sections: {},
      new_sections: sections
    });

    const resolvedQa = [
      ["qa-demo-1", "UNSOURCED_KEY_CLAIM", "BLOCKER", "Detailed analysis", "A key percentage had no source ID.", "Added [source-demo-2] and verified its evidence."],
      ["qa-demo-2", "OUTDATED_SOURCE", "HIGH", "Recommendations", "The 2021 market note was used as current evidence.", "Removed it from current recommendations and retained it only in limitations."],
      ["qa-demo-3", "UNRESOLVED_SOURCE_CONFLICT", "BLOCKER", "Executive summary", "Conflicting adoption results were not reconciled.", "Separated first-month and post-onboarding time horizons."],
      ["qa-demo-4", "DUPLICATE_SOURCE", "MEDIUM", "Source library", "Source 9 duplicates source 1.", "Marked the duplicate and excluded it from the report."],
      ["qa-demo-5", "EMPTY_REQUIRED_SECTION", "BLOCKER", "Risks and limitations", "The required limitations section was empty.", "Added the fixture and small-team evidence limitations."]
    ] as const;
    for (const qa of resolvedQa) {
      await insert(client, "qa_findings", {
        id: qa[0],
        project_id: ids.project,
        deliverable_id: ids.deliverable,
        rule_code: qa[1],
        severity: qa[2],
        location: qa[3],
        problem: qa[4],
        remediation: qa[5],
        resolution_status: "RESOLVED",
        metadata: { fixture: true, demonstratesHistoricalQa: true },
        resolved_at: "2026-08-20T14:00:00Z"
      });
    }

    await insert(client, "ai_runs", {
      id: "ai-run-demo-1",
      project_id: ids.project,
      stage: "BRIEF_ANALYSIS",
      provider: "mock",
      model: "deterministic-fixture-v1",
      prompt_template_version: "brief-analysis.v1",
      duration_ms: 7,
      usage: { inputUnits: 1, outputUnits: 1, billable: false },
      status: "SUCCEEDED",
      input_reference: { projectId: ids.project, fixture: true },
      output_reference: { questionIds: questions.map((question) => question.id) },
      completed_at: "2026-08-16T08:55:00Z"
    });
    const auditRows = [
      ["audit-demo-1", "SYSTEM", "Demo seed", "PROJECT_CREATED", "research_project", ids.project],
      ["audit-demo-2", "USER", "Demo researcher", "SCOPE_APPROVED", "research_project", ids.project],
      ["audit-demo-3", "USER", "Demo researcher", "PLAN_APPROVED", "research_plan", "plan-question-demo-1"],
      ["audit-demo-4", "AI", "Mock provider", "DRAFT_GENERATED", "deliverable", ids.deliverable],
      ["audit-demo-5", "SYSTEM", "QA engine", "QA_PASSED", "deliverable", ids.deliverable],
      ["audit-demo-6", "USER", "Demo researcher", "APPROVAL_REQUESTED", "research_project", ids.project]
    ] as const;
    for (const audit of auditRows) {
      await insert(client, "audit_events", {
        id: audit[0],
        project_id: ids.project,
        actor_type: audit[1],
        actor_label: audit[2],
        action: audit[3],
        resource_type: audit[4],
        resource_id: audit[5],
        before_state: null,
        after_state: { fixture: true }
      });
    }

    await client.query("COMMIT");
    process.stdout.write("Seeded API-key-free sample project " + ids.project + ".\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown seed error";
  process.stderr.write("Seed failed: " + message + "\n");
  process.exitCode = 1;
});
