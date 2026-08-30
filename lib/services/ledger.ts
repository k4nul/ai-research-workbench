import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import {
  claimEvidenceLinkSchema,
  claimInputSchema,
  findingInputSchema
} from "@/lib/validation";
import { writeAuditEvent } from "@/lib/services/audit";
import { notFound } from "@/lib/services/errors";
import { refreshProjectProgress } from "@/lib/services/progress";
import { invalidateDownstreamReview } from "@/lib/services/review-state";

async function refreshClaimSupport(
  client: import("pg").PoolClient,
  claimId: string
): Promise<string> {
  const counts = await client.query<{
    supports: string;
    refutes: string;
    outdated: string;
  }>(
    "SELECT COUNT(*) FILTER (WHERE ce.relationship = 'SUPPORTS' AND e.verification_status = 'VERIFIED')::text AS supports, COUNT(*) FILTER (WHERE ce.relationship = 'REFUTES' AND e.verification_status = 'VERIFIED')::text AS refutes, COUNT(*) FILTER (WHERE s.freshness_status = 'OUTDATED' AND ce.relationship = 'SUPPORTS')::text AS outdated FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id JOIN sources s ON s.id = e.source_id WHERE ce.claim_id = $1",
    [claimId]
  );
  const row = counts.rows[0];
  const supports = Number(row.supports);
  const refutes = Number(row.refutes);
  const status =
    supports > 0 && refutes > 0
      ? "CONTESTED"
      : supports === 0
        ? "UNSUPPORTED"
        : Number(row.outdated) === supports
          ? "OUTDATED"
          : "SUPPORTED";
  await client.query(
    "UPDATE claims SET support_status = $2, updated_at = NOW() WHERE id = $1",
    [claimId, status]
  );
  return status;
}

export async function addClaim(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = claimInputSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const project = await client.query("SELECT id FROM research_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) {
      throw notFound("Project");
    }
    if (input.questionId) {
      const question = await client.query(
        "SELECT id FROM research_questions WHERE id = $1 AND project_id = $2",
        [input.questionId, projectId]
      );
      if (!question.rowCount) {
        throw notFound("Research question");
      }
    }
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO claims (id, project_id, question_id, content, claim_type, importance, support_status, fact_or_inference, include_in_report, resolution_notes) VALUES ($1, $2, $3, $4, $5, $6, 'UNSUPPORTED', $7, $8, $9) RETURNING *",
      [
        id,
        projectId,
        input.questionId ?? null,
        input.content,
        input.claimType,
        input.importance,
        input.factOrInference,
        input.includeInReport,
        input.resolutionNotes ?? null
      ]
    );
    await invalidateDownstreamReview(client, projectId, "SYNTHESIZING");
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
      action: "CLAIM_CREATED",
      resourceType: "claim",
      resourceId: id,
      afterState: result.rows[0]
    });
    await refreshProjectProgress(client, projectId);
    return result.rows[0];
  });
}

export async function linkClaimEvidence(rawInput: unknown): Promise<Record<string, unknown>> {
  const input = claimEvidenceLinkSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const relation = await client.query<{ project_id: string }>(
      "SELECT c.project_id FROM claims c JOIN evidence e ON e.id = $2 JOIN sources s ON s.id = e.source_id WHERE c.id = $1 AND c.project_id = s.project_id",
      [input.claimId, input.evidenceId]
    );
    if (!relation.rows[0]) {
      throw notFound("Claim or project evidence");
    }
    await client.query(
      "INSERT INTO claim_evidence (claim_id, evidence_id, relationship, notes) VALUES ($1, $2, $3, $4) ON CONFLICT (claim_id, evidence_id) DO UPDATE SET relationship = EXCLUDED.relationship, notes = EXCLUDED.notes",
      [input.claimId, input.evidenceId, input.relationship, input.notes ?? null]
    );
    const supportStatus = await refreshClaimSupport(client, input.claimId);
    await invalidateDownstreamReview(
      client,
      relation.rows[0].project_id,
      "SYNTHESIZING"
    );
    await writeAuditEvent(client, {
      projectId: relation.rows[0].project_id,
      actorType: "USER",
      actorLabel: "Local user",
      action: "CLAIM_EVIDENCE_LINKED",
      resourceType: "claim",
      resourceId: input.claimId,
      afterState: {
        evidenceId: input.evidenceId,
        relationship: input.relationship,
        supportStatus
      }
    });
    await refreshProjectProgress(client, relation.rows[0].project_id);
    return { ...input, supportStatus };
  });
}

export async function listLedger(
  projectId: string,
  unsupportedOnly = false
): Promise<Record<string, unknown>[]> {
  const result = await query<Record<string, unknown>>(
    "SELECT c.*, COALESCE(json_agg(json_build_object('evidenceId', e.id, 'summary', e.summary, 'quote', e.minimal_quote, 'relationship', ce.relationship, 'sourceId', s.id, 'sourceTitle', s.title, 'publisher', s.publisher, 'reliability', s.reliability_grade, 'freshness', s.freshness_status)) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS linked_evidence FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id = c.id LEFT JOIN evidence e ON e.id = ce.evidence_id LEFT JOIN sources s ON s.id = e.source_id WHERE c.project_id = $1" +
      (unsupportedOnly ? " AND c.support_status = 'UNSUPPORTED'" : "") +
      " GROUP BY c.id ORDER BY CASE c.importance WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, c.created_at",
    [projectId]
  );
  return result.rows;
}

export async function addFinding(
  projectId: string,
  rawInput: unknown
): Promise<Record<string, unknown>> {
  const input = findingInputSchema.parse(rawInput);
  return withTransaction(async (client) => {
    const project = await client.query("SELECT id FROM research_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) {
      throw notFound("Project");
    }
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO findings (id, project_id, question_id, finding, importance, impact, limitations, can_inform_recommendation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
      [
        id,
        projectId,
        input.questionId ?? null,
        input.finding,
        input.importance,
        input.impact ?? null,
        input.limitations ?? null,
        input.canInformRecommendation
      ]
    );
    await invalidateDownstreamReview(client, projectId, "SYNTHESIZING");
    for (const claimId of input.claimIds) {
      const linked = await client.query(
        "INSERT INTO finding_claims (finding_id, claim_id) SELECT $1, id FROM claims WHERE id = $2 AND project_id = $3 ON CONFLICT DO NOTHING",
        [id, claimId, projectId]
      );
      if (!linked.rowCount) {
        throw notFound("Finding claim");
      }
    }
    await writeAuditEvent(client, {
      projectId,
      actorType: "USER",
      actorLabel: "Local user",
      action: "FINDING_CREATED",
      resourceType: "finding",
      resourceId: id,
      afterState: { finding: input.finding, claimIds: input.claimIds }
    });
    return result.rows[0];
  });
}
