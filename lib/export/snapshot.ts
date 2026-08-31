import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import type {
  ExportClaim,
  ExportDeliverable,
  ExportProject,
  ExportSource
} from "@/lib/export/render";

export interface ExportContent {
  project: ExportProject;
  deliverable: ExportDeliverable;
  sources: ExportSource[];
  claims: ExportClaim[];
  qaFindings: Record<string, unknown>[];
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function exportContentHash(content: ExportContent): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}

export async function loadExportContent(
  client: PoolClient,
  projectId: string
): Promise<ExportContent | null> {
  const project = await client.query<ExportProject>(
    `SELECT id, name, core_question, purpose, scope, exclusions, research_date,
      jurisdiction, is_sample
     FROM research_projects WHERE id = $1`,
    [projectId]
  );
  const deliverable = await client.query<ExportDeliverable>(
    `SELECT id, version, title, sections
     FROM deliverables WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
    [projectId]
  );
  if (!project.rows[0] || !deliverable.rows[0]) return null;

  const sources = await client.query<ExportSource>(
    `SELECT id, url, title, publisher, author, published_at, accessed_at,
      source_type, reliability_grade, freshness_status, usage_restrictions
     FROM sources WHERE project_id = $1 ORDER BY id`,
    [projectId]
  );
  const claims = await client.query<ExportClaim>(
    `SELECT c.id, c.content, c.claim_type, c.importance, c.support_status,
      c.fact_or_inference, c.within_scope, c.include_in_report,
      COALESCE(
        json_agg(
          json_build_object(
            'evidenceId', e.id,
            'summary', e.summary,
            'quote', e.minimal_quote,
            'relationship', ce.relationship,
            'supportExtent', e.support_extent,
            'sourceId', s.id,
            'sourceTitle', s.title
          ) ORDER BY e.id
        ) FILTER (WHERE e.id IS NOT NULL),
        '[]'::json
      ) AS linked_evidence
     FROM claims c
     LEFT JOIN claim_evidence ce ON ce.claim_id = c.id
     LEFT JOIN evidence e ON e.id = ce.evidence_id AND e.is_current = TRUE
     LEFT JOIN sources s ON s.id = e.source_id
     WHERE c.project_id = $1 AND c.is_current = TRUE
     GROUP BY c.id
     ORDER BY c.id`,
    [projectId]
  );
  const qaFindings = await client.query<Record<string, unknown>>(
    `SELECT rule_code, severity, location, problem, remediation,
      resolution_status, created_at, resolved_at
     FROM qa_findings
     WHERE project_id = $1 AND is_current = TRUE
     ORDER BY created_at, id`,
    [projectId]
  );
  return {
    project: project.rows[0],
    deliverable: deliverable.rows[0],
    sources: sources.rows,
    claims: claims.rows,
    qaFindings: qaFindings.rows
  };
}
