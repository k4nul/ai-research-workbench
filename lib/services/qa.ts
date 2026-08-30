import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import {
  hasBlockingQaFindings,
  runQaRules,
  type QaContext,
  type QaFinding,
  type QaReportSection
} from "@/lib/domain/qa";
import { conflict, notFound } from "@/lib/services/errors";
import { writeAuditEvent } from "@/lib/services/audit";
import { refreshProjectProgress } from "@/lib/services/progress";
import type { ReportSections } from "@/lib/validation";

const reportSectionNames: Array<[keyof ReportSections, string, boolean]> = [
  ["researchPurpose", "Research purpose", true],
  ["executiveSummary", "Executive summary", true],
  ["researchScope", "Research scope", true],
  ["methodology", "Methodology", true],
  ["keyFindings", "Key findings", true],
  ["detailedAnalysis", "Detailed analysis", true],
  ["comparisonTable", "Comparison table", false],
  ["risksAndLimitations", "Risks and limitations", true],
  ["recommendations", "Recommendations", true],
  ["references", "References", true],
  ["appendix", "Appendix", false]
];

function uniqueCitations(sections: ReportSections): string[] {
  const citations = Object.values(sections)
    .flatMap((content) => Array.from(content.matchAll(/\[([^\]]+)\]/g), (match) => match[1]))
    .filter((value) => value.length > 0);
  return [...new Set(citations)];
}

function numberTokens(value: string): string[] {
  return Array.from(value.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g), (match) => match[0]);
}

function unitTokens(value: string): string[] {
  const normalized = value.toLowerCase().replaceAll("%", " percent ");
  return ["percent", "hour", "day", "month", "year", "usd", "dollar", "kg", "km"].filter(
    (unit) => normalized.includes(unit)
  );
}

async function buildQaContext(projectId: string): Promise<{
  context: QaContext;
  deliverableId: string;
}> {
  const [projectResult, sourcesResult, evidenceResult, claimsResult, linksResult, questionsResult, deliverableResult] =
    await Promise.all([
      query<{
        research_date: string;
        source_max_age_days: number;
      }>(
        "SELECT research_date::text, source_max_age_days FROM research_projects WHERE id = $1",
        [projectId]
      ),
      query<{
        id: string;
        title: string;
        publisher: string | null;
        published_at: string | null;
        content_hash: string | null;
        duplicate_of_source_id: string | null;
      }>(
        "SELECT id, title, publisher, published_at::text, content_hash, duplicate_of_source_id FROM sources WHERE project_id = $1",
        [projectId]
      ),
      query<{
        id: string;
        source_id: string;
        verification_status: "PENDING" | "VERIFIED" | "REJECTED";
        minimal_quote: string | null;
        summary: string;
      }>(
        "SELECT e.* FROM evidence e JOIN sources s ON s.id = e.source_id WHERE s.project_id = $1",
        [projectId]
      ),
      query<{
        id: string;
        content: string;
        importance: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
        include_in_report: boolean;
        claim_type: string;
        fact_or_inference: string;
        question_id: string | null;
        resolution_notes: string | null;
      }>("SELECT * FROM claims WHERE project_id = $1", [projectId]),
      query<{
        claim_id: string;
        evidence_id: string;
        relationship: "SUPPORTS" | "REFUTES" | "CONTEXT";
      }>(
        "SELECT ce.* FROM claim_evidence ce JOIN claims c ON c.id = ce.claim_id WHERE c.project_id = $1",
        [projectId]
      ),
      query<{
        id: string;
        gap_status: "NONE" | "OPEN" | "ACCEPTED" | "RESOLVED";
        research_gap: string | null;
      }>("SELECT id, gap_status, research_gap FROM research_questions WHERE project_id = $1", [projectId]),
      query<{
        id: string;
        sections: ReportSections;
      }>(
        "SELECT id, sections FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
        [projectId]
      )
    ]);
  const project = projectResult.rows[0];
  const deliverable = deliverableResult.rows[0];
  if (!project) {
    throw notFound("Project");
  }
  if (!deliverable) {
    throw conflict("NO_DELIVERABLE", "Create a report before running QA.");
  }

  const evidenceById = new Map(evidenceResult.rows.map((evidence) => [evidence.id, evidence]));
  const questionIds = new Set(questionsResult.rows.map((question) => question.id));
  const supportLinks = new Map<string, typeof linksResult.rows>();
  for (const link of linksResult.rows) {
    const links = supportLinks.get(link.claim_id) ?? [];
    links.push(link);
    supportLinks.set(link.claim_id, links);
  }

  const sections: QaReportSection[] = reportSectionNames.map(([id, title, required]) => ({
    id,
    title,
    required,
    content: deliverable.sections[id] ?? ""
  }));
  const statements = claimsResult.rows
    .filter((claim) => claim.include_in_report)
    .map((claim) => ({
      id: claim.id,
      location: "claim:" + claim.id,
      text: claim.content,
      classification:
        claim.claim_type === "FACT" && claim.fact_or_inference === "FACT"
          ? ("FACT" as const)
          : claim.claim_type !== "FACT" && claim.fact_or_inference === "INFERENCE"
            ? ("INFERENCE" as const)
            : ("MIXED" as const),
      withinScope:
        (!claim.question_id || questionIds.has(claim.question_id)) &&
        !claim.resolution_notes?.includes("[OUT_OF_SCOPE]")
    }));
  const quantitativeAssertions = claimsResult.rows
    .filter((claim) => claim.include_in_report && numberTokens(claim.content).length > 0)
    .map((claim) => {
      const supporting = (supportLinks.get(claim.id) ?? []).find(
        (link) => link.relationship === "SUPPORTS"
      );
      const evidence = supporting ? evidenceById.get(supporting.evidence_id) : undefined;
      const sourceText = evidence
        ? evidence.summary + " " + (evidence.minimal_quote ?? "")
        : "";
      const claimNumbers = numberTokens(claim.content);
      const sourceNumbers = new Set(numberTokens(sourceText));
      const claimUnits = unitTokens(claim.content);
      const sourceUnits = new Set(unitTokens(sourceText));
      return {
        id: claim.id,
        location: "claim:" + claim.id,
        text: claim.content,
        evidenceId: evidence?.id ?? null,
        valueMatchesSource: claimNumbers.every((number) => sourceNumbers.has(number)),
        unitMatchesSource:
          claimUnits.length === 0 || claimUnits.every((unit) => sourceUnits.has(unit)),
        dateMatchesSource: !claim.resolution_notes?.includes("[DATE_MISMATCH]")
      };
    });

  const conflicts = claimsResult.rows.flatMap((claim) => {
    const links = supportLinks.get(claim.id) ?? [];
    const hasSupport = links.some((link) => link.relationship === "SUPPORTS");
    const hasRefute = links.some((link) => link.relationship === "REFUTES");
    if (!hasSupport || !hasRefute) {
      return [];
    }
    return [
      {
        id: "conflict-" + claim.id,
        claimId: claim.id,
        location: "claim:" + claim.id,
        description: "Verified sources both support and refute this claim.",
        resolved: Boolean(claim.resolution_notes?.trim())
      }
    ];
  });

  return {
    deliverableId: deliverable.id,
    context: {
      researchDate: project.research_date,
      sourceMaxAgeDays: project.source_max_age_days,
      sources: sourcesResult.rows.map((source) => ({
        id: source.id,
        title: source.title,
        publisher: source.publisher,
        publishedAt: source.published_at,
        contentHash: source.content_hash,
        duplicateOfSourceId: source.duplicate_of_source_id
      })),
      evidence: evidenceResult.rows.map((evidence) => ({
        id: evidence.id,
        sourceId: evidence.source_id,
        verificationStatus: evidence.verification_status
      })),
      claims: claimsResult.rows.map((claim) => ({
        id: claim.id,
        content: claim.content,
        importance: claim.importance,
        includeInReport: claim.include_in_report
      })),
      claimEvidence: linksResult.rows.map((link) => ({
        claimId: link.claim_id,
        evidenceId: link.evidence_id,
        relationship: link.relationship
      })),
      conflicts,
      researchGaps: questionsResult.rows.map((question) => ({
        id: question.id,
        location: "question:" + question.id,
        description: question.research_gap ?? "",
        gapStatus: question.gap_status
      })),
      report: {
        citationIds: uniqueCitations(deliverable.sections),
        sections,
        statements,
        quantitativeAssertions
      }
    }
  };
}

export async function runProjectQa(projectId: string): Promise<{
  passed: boolean;
  findings: QaFinding[];
}> {
  const { context, deliverableId } = await buildQaContext(projectId);
  const findings = runQaRules(context);
  const passed = !hasBlockingQaFindings(findings);
  await withTransaction(async (client) => {
    await client.query(
      "DELETE FROM qa_findings WHERE project_id = $1 AND resolution_status = 'OPEN' AND metadata->>'generatedBy' = 'qa-engine'",
      [projectId]
    );
    for (const finding of findings) {
      await client.query(
        "INSERT INTO qa_findings (id, project_id, deliverable_id, rule_code, severity, location, problem, remediation, resolution_status, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', $9::jsonb)",
        [
          randomUUID(),
          projectId,
          deliverableId,
          finding.ruleCode,
          finding.severity,
          finding.location,
          finding.problem,
          finding.remediation,
          JSON.stringify({ ...finding.metadata, generatedBy: "qa-engine" })
        ]
      );
    }
    await client.query(
      "UPDATE research_projects SET qa_passed_at = $2, status = $3, updated_at = NOW() WHERE id = $1",
      [projectId, passed ? new Date() : null, passed ? "APPROVAL_REQUIRED" : "QA"]
    );
    await writeAuditEvent(client, {
      projectId,
      actorType: "SYSTEM",
      actorLabel: "QA engine",
      action: passed ? "QA_PASSED" : "QA_BLOCKED",
      resourceType: "deliverable",
      resourceId: deliverableId,
      afterState: {
        findingCount: findings.length,
        blockerCount: findings.filter((finding) => finding.severity === "BLOCKER").length
      }
    });
    await refreshProjectProgress(client, projectId);
  });
  return { passed, findings };
}

export async function resolveQaFinding(
  projectId: string,
  findingId: string,
  resolutionStatus: "RESOLVED" | "ACCEPTED_RISK"
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    const before = await client.query(
      "SELECT * FROM qa_findings WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [findingId, projectId]
    );
    if (!before.rows[0]) {
      throw notFound("QA finding");
    }
    const result = await client.query(
      "UPDATE qa_findings SET resolution_status = $3, resolved_at = CASE WHEN $3 = 'RESOLVED' THEN NOW() ELSE NULL END, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING *",
      [findingId, projectId, resolutionStatus]
    );
    if (before.rows[0].severity === "BLOCKER" && resolutionStatus !== "RESOLVED") {
      await client.query(
        "UPDATE research_projects SET qa_passed_at = NULL, status = 'QA', updated_at = NOW() WHERE id = $1",
        [projectId]
      );
    }
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
      action: "QA_FINDING_UPDATED",
      resourceType: "qa_finding",
      resourceId: findingId,
      beforeState: before.rows[0],
      afterState: result.rows[0]
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function listQaFindings(projectId: string): Promise<Record<string, unknown>[]> {
  const project = await query("SELECT id FROM research_projects WHERE id = $1", [projectId]);
  if (!project.rowCount) {
    throw notFound("Project");
  }
  const result = await query<Record<string, unknown>>(
    "SELECT * FROM qa_findings WHERE project_id = $1 ORDER BY CASE severity WHEN 'BLOCKER' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, created_at DESC",
    [projectId]
  );
  return result.rows;
}
