import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "@/lib/db";
import {
  executeSyntheticEvalCorpus,
  SYNTHETIC_EVAL_GOLD,
  SYNTHETIC_EVAL_INPUTS
} from "@/lib/evaluation";
import { resetTestDatabase } from "@/tests/helpers/database";

beforeEach(async () => {
  await resetTestDatabase();
  await query("DELETE FROM provider_rate_windows");
});

afterAll(async () => {
  await closePool();
});

describe("pipeline-backed synthetic evaluation", () => {
  it(
    "runs all ten fixtures twice through the persisted eleven-stage mock pipeline",
    async () => {
      await query(
        `INSERT INTO provider_rate_windows (
           provider, operation, window_started_at, window_seconds,
           request_limit, request_count, concurrency_limit, in_flight
         ) VALUES ('mock-ai', 'ai.run', NOW(), 86400, 1, 1, 1, 0)`
      );
      const { summary, executions } = await executeSyntheticEvalCorpus(
        SYNTHETIC_EVAL_INPUTS,
        SYNTHETIC_EVAL_GOLD,
        { evaluationLabel: "integration-evaluation" }
      );

      expect(summary).toMatchObject({
        schemaVersion: "research-eval-v2",
        executionMode: "durable-postgresql-orchestration",
        repetitionsPerFixture: 2,
        evaluatedRunCount: 20,
        accuracyScore: 1,
        passed: true,
        failures: []
      });
      expect(executions).toHaveLength(10);
      expect(summary.fixtureResults).toHaveLength(10);
      expect(summary.metrics).toMatchObject({
        citationIntegrity: 1,
        citationPrecision: 1,
        supportedClaimRate: 1,
        evidenceCoverage: 1,
        staleSourceDetection: 1,
        conflictDetection: 1,
        researchGapDetection: 1,
        qaBlockerRecall: 1,
        qaBlockerBypassCount: 0,
        crossProjectEvidenceReferenceCount: 0,
        promptInjectionPolicyBypassCount: 0,
        pipelineStageCompletion: 1,
        providerRequestCompleteness: 1,
        boundaryCompliance: 1,
        deterministicHashMismatchCount: 0,
        providerRequestCount: 220
      });
      expect(
        summary.fixtureResults.every(
          (result) =>
            result.reproducible &&
            result.outputHash === result.repeatOutputHash &&
            result.primaryRunId !== result.repeatRunId
        )
      ).toBe(true);

      const runIds = executions.flatMap((execution) => [
        execution.primary.runId,
        execution.repeat.runId
      ]);
      const persisted = await query<{
        runs: number;
        stages: number;
        executions: number;
        sources: number;
        evidence: number;
        claims: number;
        qa_findings: number;
        reports: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM research_runs
              WHERE id = ANY($1::text[])) AS runs,
           (SELECT COUNT(*)::integer FROM research_run_stages
              WHERE run_id = ANY($1::text[]) AND status = 'SUCCEEDED') AS stages,
           (SELECT COUNT(*)::integer FROM provider_executions
              WHERE run_id = ANY($1::text[]) AND status = 'SUCCEEDED') AS executions,
           (SELECT COUNT(*)::integer FROM sources s
              JOIN research_runs rr ON rr.project_id = s.project_id
              WHERE rr.id = ANY($1::text[])) AS sources,
           (SELECT COUNT(*)::integer FROM evidence e
              JOIN sources s ON s.id = e.source_id
              JOIN research_runs rr ON rr.project_id = s.project_id
              WHERE rr.id = ANY($1::text[])) AS evidence,
           (SELECT COUNT(*)::integer FROM claims c
              JOIN research_runs rr ON rr.project_id = c.project_id
              WHERE rr.id = ANY($1::text[])) AS claims,
           (SELECT COUNT(*)::integer FROM qa_findings qf
              JOIN research_runs rr ON rr.project_id = qf.project_id
              WHERE rr.id = ANY($1::text[])) AS qa_findings,
           (SELECT COUNT(*)::integer FROM deliverables d
              JOIN research_runs rr ON rr.project_id = d.project_id
              WHERE rr.id = ANY($1::text[])) AS reports`,
        [runIds]
      );
      expect(persisted.rows[0]).toMatchObject({
        runs: 20,
        stages: 220,
        executions: 220,
        reports: 20
      });
      expect(persisted.rows[0].sources).toBeGreaterThanOrEqual(20);
      expect(persisted.rows[0].evidence).toBeGreaterThan(0);
      expect(persisted.rows[0].claims).toBeGreaterThan(0);
      expect(persisted.rows[0].qa_findings).toBeGreaterThan(0);

      const permitWindows = await query<{
        operation: string;
        request_count: number;
      }>(
        "SELECT operation, request_count FROM provider_rate_windows WHERE provider = 'mock-ai' ORDER BY operation"
      );
      expect(
        permitWindows.rows.find((row) => row.operation === "ai.run")
      ).toEqual({ operation: "ai.run", request_count: 1 });
      const evaluationWindows = permitWindows.rows.filter((row) =>
        row.operation.startsWith("ai.run.synthetic-evaluation:")
      );
      expect(evaluationWindows).toHaveLength(20);
      expect(evaluationWindows.every((row) => row.request_count === 11)).toBe(
        true
      );

      const insufficient = executions.find(
        (execution) => execution.fixtureId === "insufficient"
      );
      expect(insufficient?.primary.runStatus).toBe("BLOCKED");
      expect(insufficient?.primary.gaps.map((gap) => gap.questionKey)).toContain(
        "unknown"
      );
      const injection = executions.find(
        (execution) => execution.fixtureId === "prompt-injection"
      );
      expect(
        injection?.primary.qaFindings.some((finding) =>
          finding.sourceKeys.includes("hostile-document")
        )
      ).toBe(true);
    },
    120_000
  );
});
