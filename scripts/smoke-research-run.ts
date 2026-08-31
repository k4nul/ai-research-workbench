import "dotenv/config";

import { closePool, query } from "../lib/db.js";
import {
  createResearchRun,
  getResearchRun
} from "../lib/services/research-runs.js";

const PROJECT_ID = "project-demo";
const IDEMPOTENCY_KEY = "container-smoke:v0.2.0:claim-source-deduplication";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const first = await createResearchRun({
    projectId: PROJECT_ID,
    mode: "ORCHESTRATED",
    idempotencyKey: IDEMPOTENCY_KEY,
    createdBy: "Container smoke operator",
    providerConfigSnapshot: { aiProvider: "mock-ai" },
    modelConfigSnapshot: { aiModel: "deterministic-fixture-v1" },
    searchConfigSnapshot: { searchProvider: "mock-search" }
  });
  const replay = await createResearchRun({
    projectId: PROJECT_ID,
    mode: "ORCHESTRATED",
    idempotencyKey: IDEMPOTENCY_KEY,
    createdBy: "Container smoke operator",
    providerConfigSnapshot: { aiProvider: "mock-ai" },
    modelConfigSnapshot: { aiModel: "deterministic-fixture-v1" },
    searchConfigSnapshot: { searchProvider: "mock-search" }
  });
  if (replay.run.id !== first.run.id || replay.created) {
    throw new Error("Research run idempotency replay created a duplicate run.");
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await getResearchRun(first.run.id);
    if (["FAILED", "BLOCKED", "CANCELLED"].includes(current.run.status)) {
      throw new Error(
        `Research run stopped at ${current.run.status}: ${current.run.failure_reason ?? current.run.block_reason ?? "no reason"}`
      );
    }
    if (current.run.status === "APPROVAL_REQUIRED") {
      const latest = current.stages.filter(
        (stage) =>
          !current.stages.some(
            (candidate) =>
              candidate.stage_id === stage.stage_id &&
              candidate.generation > stage.generation
          )
      );
      if (
        latest.length !== 11 ||
        latest.some((stage) => stage.status !== "SUCCEEDED")
      ) {
        throw new Error("The mock research run did not commit 11 successful stages.");
      }
      const jobCounts = await query<{ total: number; succeeded: number }>(
        "SELECT COUNT(*)::integer AS total," +
          " COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::integer AS succeeded" +
          " FROM jobs WHERE run_id = $1",
        [first.run.id]
      );
      const counts = jobCounts.rows[0];
      if (counts.total !== 11 || counts.succeeded !== 11) {
        throw new Error("The mock research run did not durably complete 11 jobs.");
      }
      process.stdout.write(
        JSON.stringify({
          status: "PASSED",
          provider: "mock-ai",
          runId: first.run.id,
          runStatus: current.run.status,
          stages: latest.length,
          jobs: counts.total,
          idempotencyReplay: "reused",
          humanApprovalBypassed: false
        }) + "\n"
      );
      return;
    }
    await delay(250);
  }
  throw new Error("The full mock research run did not finish within 120 seconds.");
}

await main().finally(() => closePool());
