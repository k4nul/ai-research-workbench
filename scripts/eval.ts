import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../lib/config.js";
import {
  executeSyntheticEvalCorpus,
  SYNTHETIC_EVAL_GOLD,
  SYNTHETIC_EVAL_INPUTS,
  type EvalSummary
} from "../lib/evaluation/index.js";
import { closePool, query } from "../lib/db.js";
import { createConfiguredObjectStorage } from "../lib/documents/runtime.js";
import {
  discardGeneratedArtifact,
  persistGeneratedArtifact,
  type GeneratedArtifactReference
} from "../lib/services/generated-artifacts.js";

function markdown(summary: EvalSummary): string {
  const lines = [
    "# Synthetic research quality evaluation",
    "",
    `- Result: **${summary.passed ? "PASSED" : "FAILED"}**`,
    `- Schema: \`${summary.schemaVersion}\``,
    `- Execution: \`${summary.executionMode}\``,
    `- Pipeline: \`${summary.pipelineVersion}\``,
    `- Provider/model: \`${summary.provider}\` / \`${summary.model}\``,
    `- Fixtures: ${summary.fixtureResults.length}`,
    `- Persisted runs: ${summary.evaluatedRunCount}`,
    `- Labeled accuracy score: ${summary.accuracyScore.toFixed(4)}`,
    `- Citation integrity: ${summary.metrics.citationIntegrity.toFixed(4)}`,
    `- Citation precision: ${summary.metrics.citationPrecision.toFixed(4)}`,
    `- Supported claim rate: ${summary.metrics.supportedClaimRate.toFixed(4)}`,
    `- Evidence coverage: ${summary.metrics.evidenceCoverage.toFixed(4)}`,
    `- Unsupported critical claims: ${summary.metrics.unsupportedCriticalClaimCount}`,
    `- QA blocker bypasses: ${summary.metrics.qaBlockerBypassCount}`,
    `- Cross-project references: ${summary.metrics.crossProjectEvidenceReferenceCount}`,
    `- Prompt-injection policy bypasses: ${summary.metrics.promptInjectionPolicyBypassCount}`,
    `- Deterministic hash mismatches: ${summary.metrics.deterministicHashMismatchCount}`,
    "",
    "## Fixtures",
    "",
    "| Fixture | Runs | Citations | Claims | Evidence | Gaps | Conflicts | Reproducible |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.fixtureResults.map(
      (result) =>
        `| ${result.fixtureId} | \`${result.primaryRunId}\` / \`${result.repeatRunId}\` | ${result.citationIntegrity.toFixed(2)} | ${result.supportedClaimRate.toFixed(2)} | ${result.evidenceCoverage.toFixed(2)} | ${result.researchGapDetection.toFixed(2)} | ${result.conflictDetection.toFixed(2)} | ${result.reproducible ? "yes" : "no"} |`
    ),
    "",
    "## Failures",
    "",
    ...(summary.failures.length > 0 ? summary.failures.map((failure) => `- ${failure}`) : ["- None"]),
    "",
    "## Limitations",
    "",
    ...summary.limitations.map((limitation) => `- ${limitation}`),
    ""
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--live") ? "live" : "mock";
  if (mode === "live") {
    const configured = Boolean(process.env.OPENAI_API_KEY && process.env.BRAVE_SEARCH_API_KEY);
    if (!configured) {
      await query(
        "INSERT INTO evaluation_runs (id, kind, status, pipeline_version, provider, prompt_version, summary, completed_at) VALUES ($1, 'LIVE', 'NOT_RUN_NO_CREDENTIALS', $2, 'openai+brave', $3, $4::jsonb, NOW())",
        [
          randomUUID(),
          "research-pipeline-v2",
          "research-prompts-v2",
          JSON.stringify({ accuracyScore: null, reason: "Credentials were not configured." })
        ]
      );
    }
    process.stdout.write(
      JSON.stringify({
        mode: "live",
        status: configured ? "NOT_APPLICABLE_USE_PROVIDER_CANARY" : "NOT_RUN_NO_CREDENTIALS",
        accuracyScore: null,
        reason: configured
          ? "Live provider compatibility is checked by the canary; unlabeled live output is not assigned an accuracy score."
          : "OPENAI_API_KEY and BRAVE_SEARCH_API_KEY are both required."
      }) + "\n"
    );
    return;
  }

  const outputIndex = process.argv.indexOf("--output");
  const requested = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const outputDirectory = path.resolve(requested ?? ".artifacts/evals/mock");
  const evaluationRunId = randomUUID();
  await query(
    "INSERT INTO evaluation_runs (id, kind, status, pipeline_version, provider, model, prompt_version, fixture_count, summary) VALUES ($1, 'MOCK', 'RUNNING', 'research-pipeline-v2', 'mock-ai', 'deterministic-fixture-v1', 'research-prompts-v2', $2, $3::jsonb)",
    [
      evaluationRunId,
      SYNTHETIC_EVAL_INPUTS.length,
      JSON.stringify({
        schemaVersion: "research-eval-v2",
        executionMode: "durable-postgresql-orchestration",
        accuracyScore: null,
        state: "RUNNING"
      })
    ]
  );
  let summary: EvalSummary;
  const persistedArtifacts: GeneratedArtifactReference[] = [];
  try {
    ({ summary } = await executeSyntheticEvalCorpus(
      SYNTHETIC_EVAL_INPUTS,
      SYNTHETIC_EVAL_GOLD,
      { evaluationLabel: evaluationRunId }
    ));
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const summaryJson = JSON.stringify(summary, null, 2) + "\n";
    const summaryMarkdown = markdown(summary);
    await Promise.all([
      writeFile(
        path.join(outputDirectory, "eval-summary.json"),
        summaryJson,
        { mode: 0o600 }
      ),
      writeFile(path.join(outputDirectory, "eval-summary.md"), summaryMarkdown, {
        mode: 0o600
      })
    ]);
    const config = getConfig();
    const storage = createConfiguredObjectStorage(config);
    const bucket = config.storageProvider === "s3" ? config.s3Bucket : "private";
    const jsonArtifact = await persistGeneratedArtifact({
        storage,
        bucket,
        category: "evaluations",
        artifactId: evaluationRunId,
        filename: "eval-summary.json",
        contentType: "application/json",
        bytes: new TextEncoder().encode(summaryJson),
        createdBy: `evaluation:${evaluationRunId}`,
        maxBytes: config.storageMaxObjectBytes
      });
    persistedArtifacts.push(jsonArtifact);
    const markdownArtifact = await persistGeneratedArtifact({
        storage,
        bucket,
        category: "evaluations",
        artifactId: evaluationRunId,
        filename: "eval-summary.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: new TextEncoder().encode(summaryMarkdown),
        createdBy: `evaluation:${evaluationRunId}`,
        maxBytes: config.storageMaxObjectBytes
      });
    persistedArtifacts.push(markdownArtifact);
    await query(
      "UPDATE evaluation_runs SET status = $2, pipeline_version = $3, provider = $4, model = $5, prompt_version = $6, fixture_count = $7, summary = $8::jsonb, artifact_reference = $9::jsonb, estimated_cost = $10, completed_at = NOW() WHERE id = $1",
      [
        evaluationRunId,
        summary.passed ? "PASSED" : "FAILED",
        summary.pipelineVersion,
        summary.provider,
        summary.model,
        summary.promptVersion,
        summary.fixtureResults.length,
        JSON.stringify(summary),
        JSON.stringify({
          json: path.relative(
            process.cwd(),
            path.join(outputDirectory, "eval-summary.json")
          ),
          markdown: path.relative(
            process.cwd(),
            path.join(outputDirectory, "eval-summary.md")
          ),
          objects: {
            json: jsonArtifact,
            markdown: markdownArtifact
          },
          primaryRunIds: summary.fixtureResults.map((result) => result.primaryRunId),
          repeatRunIds: summary.fixtureResults.map((result) => result.repeatRunId)
        }),
        summary.metrics.estimatedCostUsd
      ]
    );
  } catch (error) {
    const config = getConfig();
    const storage = createConfiguredObjectStorage(config);
    await Promise.allSettled(
      persistedArtifacts.map((reference) =>
        discardGeneratedArtifact({
          storage,
          reference,
          reason: "Evaluation artifact persistence did not complete."
        })
      )
    );
    await query(
      "UPDATE evaluation_runs SET status = 'FAILED', summary = $2::jsonb, completed_at = NOW() WHERE id = $1",
      [
        evaluationRunId,
        JSON.stringify({
          schemaVersion: "research-eval-v2",
          executionMode: "durable-postgresql-orchestration",
          accuracyScore: null,
          error:
            error instanceof Error
              ? error.message
              : "Synthetic evaluation failed before scoring."
        })
      ]
    );
    throw error;
  }
  process.stdout.write(
    `${summary.passed ? "PASSED" : "FAILED"}: ${summary.fixtureResults.length} synthetic fixtures across ${summary.evaluatedRunCount} persisted runs; artifacts ${outputDirectory}\n`
  );
  if (!summary.passed) {
    process.exitCode = 1;
  }
}

await main().finally(() => closePool());
