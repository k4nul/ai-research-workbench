import "dotenv/config";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Browser, type Download, type Page, type Response } from "@playwright/test";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { closePool, query } from "@/lib/db";
import { claimJobs, failJob, startJob, submitJob } from "@/lib/services/jobs";
import { approvePlan, approveScope, createProject } from "@/lib/services/projects";
import { heartbeatWorker, registerWorker } from "@/lib/services/workers";

import { E2E_NORMAL_OPERATOR } from "./auth-fixture";
import { gotoApp, reloadApp } from "./helpers/app-ready";

const baseUrl = process.env.APP_URL ?? "https://127.0.0.1:3100";
const execFileAsync = promisify(execFile);
const workerHelper = path.join(process.cwd(), "e2e", "helpers", "operations-worker.ts");
const operationsCoreQuestion = "Can durable mock research remain observable and recoverable?";
const operationsQuestion = "Does the durable pipeline preserve one observable effect per stage?";
const generatedClaimText = `Demo claim for: ${operationsCoreQuestion}`;
const generatedEvidenceSummary =
  "Durable execution supports repeatable recovery. Persisted stage commits prevent duplicate domain effects.";
const verifiedEvidenceSummary =
  "Human verification confirms that persisted stage commits prevent duplicate domain effects.";
const coldRouteTimeout = 60_000;
const projectIds: string[] = [];
let monitoredProjectId = "";
let monitoredProjectName = "";
let monitoredQuestionId = "";
let monitoredSourceId = "";
let monitoredSourceTitle = "";
let resumableProjectId = "";
let leaseRecoveryProjectId = "";
let monitoredRunId = "";
let resumableRunId = "";
let leaseRecoveryRunId = "";
let browserRetryJobId = "";
let browserRetryJobType = "";
let browserWorkerId = "";
let browserEvaluationId = "";
let browserEvaluationPromptVersion = "";
let browserDocumentId = "";
let browserDocumentObjectId = "";
let browserDocumentFilename = "";

function idempotencyKey(request: { headers(): Record<string, string> }): string {
  const value = request.headers()["idempotency-key"];
  if (!value) throw new Error("The browser request did not contain an idempotency key.");
  return value;
}

async function responseRunId(response: Response): Promise<string> {
  const payload = (await response.json()) as {
    data?: { run?: { id?: unknown } };
  };
  const runId = payload.data?.run?.id;
  if (typeof runId !== "string" || !runId) {
    throw new Error("The create-run response did not contain a run ID.");
  }
  return runId;
}

function waitForApiResponse(
  page: Page,
  method: "GET" | "PATCH" | "POST",
  pathname: string
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === pathname,
    { timeout: coldRouteTimeout }
  );
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error(`Playwright could not open downloaded artifact ${download.suggestedFilename()}.`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function createApprovedOperationsProject(
  label: string,
  suffix: string
): Promise<{
  projectId: string;
  projectName: string;
  questionId: string;
  sourceId: string;
  sourceTitle: string;
}> {
  const projectName = `E2E ${label} ${suffix}`;
  const project = await createProject({
    mode: "detailed",
    name: projectName,
    clientName: "E2E operations fixture",
    coreQuestion: operationsCoreQuestion,
    background: "Synthetic browser and worker operations fixture.",
    purpose: "Verify authenticated durable operations without external network access.",
    audience: "Test operator",
    scope: "Browser operations and deterministic durable research stages.",
    exclusions: "Live provider calls and customer data.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "DOCX"],
    specialRequirements: "Use synthetic fixtures only."
  });
  projectIds.push(project.id);
  await approveScope(project.id);
  const questionId = randomUUID();
  await query(
    `INSERT INTO research_questions (
       id, project_id, question, priority, status, completion_criteria, gap_status
     ) VALUES ($1, $2, $3, 'HIGH', 'PLANNED', $4, 'NONE')`,
    [
      questionId,
      project.id,
      operationsQuestion,
      "Complete eleven deterministic stages and stop for approval."
    ]
  );
  const sourceId = randomUUID();
  const sourceTitle = `Synthetic durable execution source ${suffix}`;
  await query(
    `INSERT INTO research_plans (
       id, project_id, question_id, search_strategy, search_queries,
       primary_source_types, secondary_source_types, comparison_targets,
       expected_output, completion_condition, expected_risks, ai_suggested
     ) VALUES ($1, $2, $3, $4, $5, $6, ARRAY[]::text[], $7, $8, $9, $10, FALSE)`,
    [
      randomUUID(),
      project.id,
      questionId,
      "Use the same-project deterministic synthetic source.",
      ["durable mock pipeline evidence"],
      ["SYNTHETIC"],
      ["durable stage state"],
      "A cited synthetic draft and review boundary.",
      "Every stage result is persisted once.",
      ["Worker lease loss"]
    ]
  );
  await approvePlan(project.id);
  await query(
    `INSERT INTO sources (
       id, project_id, title, publisher, published_at, source_type, language,
       reliability_grade, freshness_status, ingestion_method, mime_type,
       content_summary, sanitized_content
     ) VALUES ($1, $2, $3, 'E2E fixture publisher', '2026-08-30', 'SYNTHETIC',
       'en', 'A', 'CURRENT', 'MANUAL', 'text/plain', $4, $5)`,
    [
      sourceId,
      project.id,
      sourceTitle,
      "Synthetic evidence about durable stage recovery.",
      generatedEvidenceSummary
    ]
  );
  return { projectId: project.id, projectName, questionId, sourceId, sourceTitle };
}

async function runWorkerCommand<T>(command: "cycle" | "lease-recovery", runId: string): Promise<T> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", workerHelper, command, runId],
    {
      cwd: process.cwd(),
      env: process.env,
      timeout: 150_000,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024
    }
  );
  const output = stdout.trim().split(/\r?\n/).at(-1);
  if (!output) {
    throw new Error(`The worker helper returned no result.${stderr ? ` ${stderr.trim()}` : ""}`);
  }
  return JSON.parse(output) as T;
}

async function runSnapshot(runId: string): Promise<{
  status: string;
  progress: number;
  total_provider_requests: number;
}> {
  const result = await query<{
    status: string;
    progress: number;
    total_provider_requests: number;
  }>(
    "SELECT status, progress, total_provider_requests FROM research_runs WHERE id = $1",
    [runId]
  );
  if (!result.rows[0]) throw new Error(`Research run ${runId} was not found.`);
  return result.rows[0];
}

async function readyJobCount(runId: string): Promise<number> {
  const result = await query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM jobs WHERE run_id = $1 AND status IN ('QUEUED', 'RETRY_WAIT', 'CLAIMED', 'RUNNING')",
    [runId]
  );
  return result.rows[0]?.count ?? 0;
}

async function executeToApproval(runId: string, page?: Page): Promise<void> {
  for (let cycle = 0; cycle < 40; cycle += 1) {
    const result = await runWorkerCommand<{ claimed: number }>("cycle", runId);
    const run = await runSnapshot(runId);
    if (page) {
      await reloadApp(page);
      await expect(page.getByRole("heading", { level: 2, name: "Run state" })).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Pipeline progress" })).toHaveAttribute(
        "aria-valuenow",
        String(run.progress)
      );
    }
    if (run.status === "APPROVAL_REQUIRED" && (await readyJobCount(runId)) === 0) {
      return;
    }
    if (result.claimed === 0 && (await readyJobCount(runId)) === 0) {
      throw new Error(`Run ${runId} stopped in ${run.status} before approval.`);
    }
  }
  throw new Error(`Run ${runId} did not reach the approval boundary.`);
}

async function createRunNormally(page: Page, projectId: string): Promise<string> {
  await gotoApp(page, "/runs");
  await page.getByLabel("Approved project").selectOption(projectId);
  await page.getByLabel("Execution mode").selectOption("ORCHESTRATED");
  const responsePromise = waitForApiResponse(page, "POST", "/api/runs");
  await page.getByRole("button", { name: "Create run" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const runId = await responseRunId(response);
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  return runId;
}

async function verifyProtectedMutationBoundaries(browser: Browser, page: Page): Promise<void> {
  const anonymousContext = await browser.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] }
  });
  try {
    const anonymousPage = await anonymousContext.newPage();
    await gotoApp(anonymousPage, "/login");
    const anonymous = await anonymousPage.evaluate(async () => {
      const response = await fetch("/api/runs");
      return { status: response.status, payload: await response.json() };
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.payload).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });
  } finally {
    await anonymousContext.close();
  }

  await gotoApp(page, "/runs");
  const missingCsrf = await page.evaluate(async (projectId) => {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "missing-csrf-e2e-mutation"
      },
      body: JSON.stringify({ projectId, mode: "ORCHESTRATED" })
    });
    return { status: response.status, payload: await response.json() };
  }, monitoredProjectId);
  expect(missingCsrf.status).toBe(403);
  expect(missingCsrf.payload).toMatchObject({ error: { code: "CSRF_INVALID" } });

  const protectedRead = await page.request.get("/api/runs?limit=1");
  expect(protectedRead.status()).toBe(200);
}

test.describe.serial("authenticated durable operations", () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const suffix = randomUUID().slice(0, 8);
    const monitored = await createApprovedOperationsProject("monitored run", suffix);
    monitoredProjectId = monitored.projectId;
    monitoredProjectName = monitored.projectName;
    monitoredQuestionId = monitored.questionId;
    monitoredSourceId = monitored.sourceId;
    monitoredSourceTitle = monitored.sourceTitle;
    resumableProjectId = (
      await createApprovedOperationsProject("resumable run", suffix)
    ).projectId;
    leaseRecoveryProjectId = (
      await createApprovedOperationsProject("lease recovery", suffix)
    ).projectId;

    browserWorkerId = `e2e-browser-worker-${suffix}`;
    await registerWorker({
      workerId: browserWorkerId,
      serviceVersion: "0.2.0",
      concurrency: 1,
      providerConcurrency: 1,
      extractionConcurrency: 1,
      metadata: { fixture: "playwright" }
    });
    expect(
      await heartbeatWorker({ workerId: browserWorkerId, status: "READY", activeJobs: 0 })
    ).toBe(true);

    browserRetryJobType = `E2E_MANUAL_RETRY_${suffix}`;
    const retryJob = await submitJob({
      projectId: monitoredProjectId,
      jobType: browserRetryJobType,
      inputReference: { fixture: "playwright-manual-retry" },
      idempotencyKey: `e2e-manual-retry:${suffix}`,
      maxAttempts: 1
    });
    browserRetryJobId = retryJob.job.id;
    const retryWorkerId = `e2e-retry-worker-${suffix}`;
    const claimed = (
      await claimJobs({
        workerId: retryWorkerId,
        limit: 1,
        leaseDurationMs: 30_000,
        jobTypes: [browserRetryJobType]
      })
    )[0];
    if (!claimed || claimed.id !== browserRetryJobId) {
      throw new Error("The synthetic manual-retry job was not claimed.");
    }
    await startJob(claimed.id, retryWorkerId, claimed.version);
    await failJob({
      jobId: claimed.id,
      workerId: retryWorkerId,
      errorClass: "NON_RETRYABLE_VALIDATION",
      error: new Error("Synthetic operator retry fixture")
    });

    browserDocumentId = randomUUID();
    browserDocumentObjectId = randomUUID();
    browserDocumentFilename = `e2e-processing-state-${suffix}.txt`;
    await query(
      `INSERT INTO storage_objects (
         id, provider, bucket, object_key, content_type, original_filename,
         sanitized_filename, byte_size, sha256, integrity_status, upload_status,
         scan_status, extraction_status, retention_status, project_id, created_by
       ) VALUES ($1, 'LOCAL', 'private', $2, 'text/plain', $3, $3, 32, $4,
         'VERIFIED', 'AVAILABLE', 'UNSCANNED', 'NOT_REQUESTED', 'ACTIVE', $5, 'e2e')`,
      [
        browserDocumentObjectId,
        `quarantine/${browserDocumentObjectId}.txt`,
        browserDocumentFilename,
        "a".repeat(64),
        monitoredProjectId
      ]
    );
    await query(
      `INSERT INTO documents (
         id, project_id, raw_object_id, status, created_by
       ) VALUES ($1, $2, $3, 'QUARANTINED', 'e2e')`,
      [browserDocumentId, monitoredProjectId, browserDocumentObjectId]
    );

    browserEvaluationId = randomUUID();
    browserEvaluationPromptVersion = `e2e.browser.${suffix}`;
    await query(
      `INSERT INTO evaluation_runs (
         id, kind, status, pipeline_version, provider, model, prompt_version,
         fixture_count, summary, artifact_reference, estimated_cost, completed_at
       ) VALUES ($1, 'MOCK', 'PASSED', 'research-pipeline.v2', 'mock-ai',
         'deterministic-fixture-v1', $2, 1, '{"failures":[]}'::jsonb,
         '{"fixture":"playwright"}'::jsonb, 0, NOW())`,
      [browserEvaluationId, browserEvaluationPromptVersion]
    );
  });

  test.afterAll(async () => {
    try {
      if (browserEvaluationId) {
        await query("DELETE FROM evaluation_runs WHERE id = $1", [browserEvaluationId]);
      }
      if (browserWorkerId) {
        await query("DELETE FROM worker_heartbeats WHERE worker_id = $1", [browserWorkerId]);
      }
      if (browserDocumentId) {
        await query("DELETE FROM documents WHERE id = $1", [browserDocumentId]);
      }
      if (browserDocumentObjectId) {
        await query("DELETE FROM storage_objects WHERE id = $1", [browserDocumentObjectId]);
      }
      for (const projectId of projectIds.reverse()) {
        await query("DELETE FROM research_projects WHERE id = $1", [projectId]);
      }
    } finally {
      await closePool();
    }
  });

  test("shows operator state across jobs, documents, evaluations, providers, and workers and retries an eligible job", async ({
    page
  }) => {
    test.setTimeout(180_000);

    await gotoApp(page, "/operations");
    await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
    for (const label of ["Queue depth", "Workers", "Provider failures", "Document failures"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    const workerCard = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { level: 3, name: browserWorkerId }) });
    await expect(page.getByRole("heading", { level: 2, name: "Worker readiness" })).toBeVisible();
    await expect(workerCard).toContainText("Ready");

    await gotoApp(page, `/jobs?projectId=${encodeURIComponent(monitoredProjectId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Job queue" })).toBeVisible();
    const retryRow = page
      .getByRole("table", { name: "Durable jobs" })
      .getByRole("row")
      .filter({ hasText: browserRetryJobType });
    await expect(retryRow).toContainText("Failed");
    await expect(retryRow.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await retryRow.getByRole("link", { name: browserRetryJobType, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Current state" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Job attempts" })).toContainText(
      "Synthetic operator retry fixture"
    );
    await expect(page.getByRole("table", { name: "Job event trail" })).toContainText(
      "Job failed"
    );
    const retryResponse = waitForApiResponse(
      page,
      "POST",
      `/api/jobs/${browserRetryJobId}/retry`
    );
    await page.getByRole("button", { name: "Retry job" }).click();
    expect((await retryResponse).status()).toBe(200);
    await expect(
      page
        .getByRole("heading", { level: 2, name: "Current state" })
        .locator("xpath=ancestor::section[1]")
    ).toContainText("Queued");
    await expect
      .poll(async () => {
        const result = await query<{ status: string; max_attempts: number }>(
          "SELECT status, max_attempts FROM jobs WHERE id = $1",
          [browserRetryJobId]
        );
        return result.rows[0];
      })
      .toEqual({ status: "QUEUED", max_attempts: 2 });

    await gotoApp(page, "/documents");
    await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
    const documentResponse = waitForApiResponse(
      page,
      "GET",
      `/api/projects/${monitoredProjectId}/documents`
    );
    await page.getByLabel("Project").selectOption(monitoredProjectId);
    expect((await documentResponse).status()).toBe(200);
    const documentCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 2, name: browserDocumentFilename }) });
    await expect(documentCard).toContainText("Quarantined", { timeout: 15_000 });
    await expect(documentCard).toContainText("Unscanned");
    await expect(documentCard).toContainText("Not requested");

    await gotoApp(page, "/evaluations");
    await expect(page.getByRole("heading", { level: 1, name: "Evaluations" })).toBeVisible();
    await expect(page.getByText("Recorded evaluations", { exact: true })).toBeVisible();
    await expect(page.getByText("Latest gate", { exact: true })).toBeVisible();
    const evaluationRow = page
      .getByRole("table", { name: "Recent evaluation results" })
      .getByRole("row")
      .filter({ hasText: browserEvaluationPromptVersion });
    await expect(evaluationRow).toContainText("Mock");
    await expect(evaluationRow).toContainText("Passed");
    await expect(evaluationRow).toContainText("research-pipeline.v2");
    await expect(evaluationRow).toContainText("mock-ai");

    await gotoApp(page, "/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings & provider status" })
    ).toBeVisible();
    const providerTable = page.getByRole("table", { name: "Configured provider status" });
    const mockAi = providerTable.getByRole("row").filter({ hasText: "mock-ai" });
    await expect(mockAi).toContainText("Active");
    await expect(mockAi).toContainText("Configured");
    const liveAi = providerTable
      .getByRole("row")
      .filter({ hasText: "openai-responses" });
    await expect(liveAi).toContainText("Not configured");
  });

  test("keeps a create key after response loss and carries all 11 mock stages through named approval and valid exports", async ({
    browser,
    page
  }) => {
    test.setTimeout(600_000);
    await verifyProtectedMutationBoundaries(browser, page);

    await gotoApp(page, "/runs");
    await page.getByLabel("Approved project").selectOption(monitoredProjectId);
    await page.getByLabel("Execution mode").selectOption("ORCHESTRATED");
    const keys: string[] = [];
    let attempts = 0;
    await page.route("**/api/runs", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      attempts += 1;
      keys.push(idempotencyKey(route.request()));
      if (attempts === 1) {
        await route.fetch();
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ response: await route.fetch() });
    });

    const createButton = page.getByRole("button", { name: "Create run" });
    await createButton.click();
    await expect(page.locator('[role="alert"][data-tone="error"]')).toBeVisible();
    await expect(createButton).toBeEnabled();
    const persistedAfterLoss = await query<{ id: string }>(
      "SELECT id FROM research_runs WHERE project_id = $1",
      [monitoredProjectId]
    );
    expect(persistedAfterLoss.rowCount).toBe(1);

    const retryResponsePromise = waitForApiResponse(page, "POST", "/api/runs");
    await createButton.click();
    const retryResponse = await retryResponsePromise;
    expect(retryResponse.status()).toBe(201);
    monitoredRunId = await responseRunId(retryResponse);
    await expect(page).toHaveURL(new RegExp(`/runs/${monitoredRunId}$`));
    await page.unroute("**/api/runs");

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const persistedAfterRetry = await query<{ id: string; idempotency_key: string }>(
      "SELECT id, idempotency_key FROM research_runs WHERE project_id = $1",
      [monitoredProjectId]
    );
    expect(persistedAfterRetry.rows).toEqual([
      { id: monitoredRunId, idempotency_key: keys[0] }
    ]);

    const initialStages = page.getByRole("table", { name: "Research run stages" });
    await expect(initialStages.locator("tbody tr")).toHaveCount(11);
    await expect(page.getByRole("progressbar", { name: "Pipeline progress" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );

    await executeToApproval(monitoredRunId, page);
    const runState = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Run state" })
    });
    await expect(runState).toContainText("Approval required");
    await expect(runState.getByRole("progressbar", { name: "Pipeline progress" })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
    await expect(
      runState.locator("dt").filter({ hasText: /^Provider requests$/ }).locator("..").locator("dd")
    ).toHaveText("11");
    const stageRows = page
      .getByRole("table", { name: "Research run stages" })
      .locator("tbody tr");
    await expect(stageRows).toHaveCount(11);
    for (let index = 0; index < 11; index += 1) {
      await expect(stageRows.nth(index)).toContainText("Succeeded");
      await expect(stageRows.nth(index)).toContainText("mock-ai");
    }

    let confirmation = "";
    page.once("dialog", async (dialog) => {
      confirmation = dialog.message();
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Rerun stage" }).first().click();
    expect(confirmation).toBe(
      "Rerun this stage? This creates a new generation and marks every downstream stage result stale."
    );
    const generations = await query<{ generation: number }>(
      "SELECT generation FROM research_run_stages WHERE run_id = $1 ORDER BY ordinal",
      [monitoredRunId]
    );
    expect(generations.rows.every((stage) => stage.generation === 1)).toBe(true);

    await test.step("review the worker-produced evidence, claim, and report in the browser", async () => {
      await gotoApp(page, `/projects/${monitoredProjectId}/sources/${monitoredSourceId}`);
      await expect(
        page.getByRole("heading", { level: 1, name: monitoredSourceTitle })
      ).toBeVisible();
      const generatedEvidenceRow = page
        .getByRole("table", { name: `Evidence from ${monitoredSourceTitle}` })
        .getByRole("row")
        .filter({ hasText: generatedEvidenceSummary });
      await expect(generatedEvidenceRow).toContainText("Pending");

      await page.getByLabel("Evidence summary").fill(verifiedEvidenceSummary);
      await page
        .getByLabel(/^Minimal quote/)
        .fill("Persisted stage commits prevent duplicate domain effects.");
      await page.getByLabel("Original location").fill("Synthetic fixture content");
      await page.getByLabel("Page or section").fill("fixture:content");
      await page.getByLabel("Confidence").selectOption("HIGH");
      await page.getByLabel("Verification").selectOption("VERIFIED");
      const evidenceResponse = waitForApiResponse(
        page,
        "POST",
        `/api/sources/${monitoredSourceId}/evidence`
      );
      await page.getByRole("button", { name: "Add evidence" }).click();
      expect((await evidenceResponse).status()).toBe(201);
      await expect(
        page.getByText("Evidence excerpt added to the source.", { exact: true })
      ).toBeVisible();
      const verifiedEvidenceRow = page
        .getByRole("table", { name: `Evidence from ${monitoredSourceTitle}` })
        .getByRole("row")
        .filter({ hasText: verifiedEvidenceSummary });
      await expect(verifiedEvidenceRow).toContainText("Verified");

      await gotoApp(page, `/projects/${monitoredProjectId}/ledger`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Claims & evidence ledger" })
      ).toBeVisible();
      let generatedClaimRow = page
        .getByRole("table", { name: "Claim and evidence ledger" })
        .getByRole("row")
        .filter({ hasText: generatedClaimText });
      await expect(generatedClaimRow).toContainText("Unsupported");
      await expect(generatedClaimRow).toContainText("Excluded");

      const evidenceLinkForm = page.locator("form").filter({
        has: page.getByRole("heading", { level: 2, name: "Link evidence" })
      });
      await evidenceLinkForm
        .getByRole("combobox", { exact: true, name: "Claim" })
        .selectOption({ label: generatedClaimText });
      await evidenceLinkForm
        .getByRole("combobox", { exact: true, name: "Evidence" })
        .selectOption({ label: `${monitoredSourceTitle}: ${verifiedEvidenceSummary}` });
      await evidenceLinkForm.getByLabel("Relationship").selectOption("SUPPORTS");
      const evidenceLinkResponse = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/ledger`
      );
      await evidenceLinkForm.getByRole("button", { name: "Link evidence" }).click();
      expect((await evidenceLinkResponse).status()).toBe(200);
      await expect(
        page.getByText("Evidence relationship saved and claim support recalculated.", {
          exact: true
        })
      ).toBeVisible();

      const claimReviewForm = page.locator("form").filter({
        has: page.getByRole("heading", { level: 2, name: "Resolve or exclude a claim" })
      });
      await claimReviewForm
        .getByRole("combobox", { exact: true, name: "Claim" })
        .selectOption({ label: generatedClaimText });
      await claimReviewForm.getByLabel("Report inclusion").selectOption("INCLUDE");
      await claimReviewForm
        .getByLabel("Resolution note")
        .fill("Named operator reviewed the worker claim and its verified support.");
      const reviewedClaimId = await claimReviewForm
        .getByRole("combobox", { exact: true, name: "Claim" })
        .inputValue();
      const claimReviewResponse = waitForApiResponse(
        page,
        "PATCH",
        `/api/projects/${monitoredProjectId}/claims/${encodeURIComponent(reviewedClaimId)}`
      );
      await claimReviewForm.getByRole("button", { name: "Save claim decision" }).click();
      expect((await claimReviewResponse).status()).toBe(200);
      await expect(
        page.getByText("Claim review decision saved; QA and approval were invalidated.", {
          exact: true
        })
      ).toBeVisible();

      await reloadApp(page);
      generatedClaimRow = page
        .getByRole("table", { name: "Claim and evidence ledger" })
        .getByRole("row")
        .filter({ hasText: generatedClaimText });
      await expect(generatedClaimRow).toContainText("Supported");
      await expect(generatedClaimRow).toContainText("Included");
      await expect(generatedClaimRow).toContainText(verifiedEvidenceSummary);

      await gotoApp(page, `/projects/${monitoredProjectId}/report`);
      await expect(page.getByRole("heading", { level: 1, name: "Report" })).toBeVisible();
      await expect(page.getByLabel("Report title")).toHaveValue(monitoredProjectName);
      for (const section of [
        "Research purpose",
        "Executive summary",
        "Research scope",
        "Methodology",
        "Key findings",
        "Detailed analysis",
        "Risks and limitations",
        "Recommendations",
        "References"
      ]) {
        await expect(page.getByLabel(new RegExp(`^${section}`))).not.toHaveValue("");
      }
      expect(await page.getByLabel(/^Key findings/).inputValue()).toContain(generatedClaimText);
      expect(await page.getByLabel(/^References/).inputValue()).toContain(
        `[@${monitoredSourceId}]`
      );
      await expect(
        page
          .getByRole("table", { name: "Report revision history" })
          .getByText("Ai", { exact: true })
      ).toBeVisible();
    });

    await test.step("complete human review, run deterministic QA, and approve the exact run", async () => {
      await gotoApp(page, `/projects/${monitoredProjectId}/plan`);
      await expect(page.getByRole("heading", { level: 1, name: "Research plan" })).toBeVisible();
      const questionCard = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { level: 3, name: operationsQuestion }) });
      await questionCard
        .getByRole("combobox", { exact: true, name: "Status" })
        .selectOption("COMPLETE");
      await questionCard
        .getByRole("combobox", { exact: true, name: "Gap status" })
        .selectOption("NONE");
      const questionResponse = waitForApiResponse(
        page,
        "PATCH",
        `/api/projects/${monitoredProjectId}/questions/${monitoredQuestionId}`
      );
      await questionCard.getByRole("button", { name: "Update" }).click();
      expect((await questionResponse).status()).toBe(200);
      await expect(questionCard.getByText("Question state updated.", { exact: true })).toBeVisible();
      await expect(
        questionCard.getByRole("combobox", { exact: true, name: "Status" })
      ).toHaveValue("COMPLETE");

      const findingText = "The durable worker preserves a reviewable effect for every stage.";
      await gotoApp(page, `/projects/${monitoredProjectId}/findings`);
      await expect(page.getByRole("heading", { level: 1, name: "Findings" })).toBeVisible();
      await page.getByRole("textbox", { exact: true, name: "Finding" }).fill(findingText);
      await page
        .getByRole("combobox", { exact: true, name: "Research question" })
        .selectOption({ label: operationsQuestion });
      await page.getByLabel("Impact").fill("Operators can audit the same-project durable result.");
      await page
        .getByLabel("Limitations")
        .fill("The acceptance flow uses the deterministic mock provider and synthetic evidence.");
      const generatedClaimOption = page
        .locator("fieldset")
        .filter({ hasText: "Linked claims" })
        .locator("label")
        .filter({ hasText: generatedClaimText });
      await generatedClaimOption.getByRole("checkbox").check();
      await page
        .getByRole("checkbox", { name: "This finding may inform a recommendation" })
        .check();
      const findingResponse = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/findings`
      );
      await page.getByRole("button", { name: "Add finding" }).click();
      expect((await findingResponse).status()).toBe(201);
      await expect(
        page.getByText("Finding created with its selected claim links.", { exact: true })
      ).toBeVisible();
      const findingRow = page
        .getByRole("table", { name: "Project findings" })
        .getByRole("row")
        .filter({ hasText: findingText });
      await expect(findingRow).toContainText("May inform");
      await expect(findingRow).toContainText("1");

      await gotoApp(page, `/projects/${monitoredProjectId}/qa`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Quality assurance" })
      ).toBeVisible();
      const qaResponse = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/qa`
      );
      await page.getByRole("button", { name: "Run QA" }).click();
      expect((await qaResponse).status()).toBe(200);
      await expect(
        page.getByText("QA run completed and findings refreshed.", { exact: true })
      ).toBeVisible();
      await expect(page.getByText("No unresolved blockers in the current finding set")).toBeVisible();
      await expect(page.getByText("No QA findings recorded", { exact: true })).toBeVisible();

      await gotoApp(page, `/projects/${monitoredProjectId}/approval`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Approval & export" })
      ).toBeVisible();
      await expect(
        page.getByText("All workflow prerequisites are ready for human approval.", { exact: true })
      ).toBeVisible();
      const requestApproval = page.getByRole("button", { name: "Request approval" });
      await expect(requestApproval).toBeEnabled();
      const requestApprovalResponse = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/approval`
      );
      await requestApproval.click();
      expect((await requestApprovalResponse).status()).toBe(200);
      await expect(
        page.getByText("Approval requested for human review.", { exact: true })
      ).toBeVisible();

      const approveProject = page.getByRole("button", { name: "Approve project" });
      await expect(approveProject).toBeDisabled();
      await page
        .getByRole("checkbox", {
          name: "I reviewed the current report, evidence, limitations, and QA state and approve this project."
        })
        .check();
      await expect(approveProject).toBeEnabled();
      const approveProjectResponse = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/approval`
      );
      await approveProject.click();
      expect((await approveProjectResponse).status()).toBe(200);
      await expect(
        page.getByText("Explicit human approval recorded.", { exact: true })
      ).toBeVisible();
      await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

      const expectedActorLabel =
        `${E2E_NORMAL_OPERATOR.displayName} (${E2E_NORMAL_OPERATOR.username})`;
      const completedRun = await query<{
        project_id: string;
        status: string;
        completed_at: string | null;
      }>(
        "SELECT project_id, status, completed_at::text FROM research_runs WHERE id = $1",
        [monitoredRunId]
      );
      expect(completedRun.rows[0]).toMatchObject({
        project_id: monitoredProjectId,
        status: "COMPLETED"
      });
      expect(completedRun.rows[0]?.completed_at).not.toBeNull();
      const approvalAudits = await query<{
        action: string;
        actor_type: string;
        actor_label: string;
        resource_type: string;
        resource_id: string | null;
      }>(
        `SELECT action, actor_type, actor_label, resource_type, resource_id
         FROM audit_events
         WHERE project_id = $1
           AND action IN ('APPROVAL_REQUESTED', 'PROJECT_APPROVED', 'RESEARCH_RUN_COMPLETED')
         ORDER BY created_at, id`,
        [monitoredProjectId]
      );
      expect(approvalAudits.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "APPROVAL_REQUESTED",
            actor_type: "USER",
            actor_label: expectedActorLabel,
            resource_type: "research_project",
            resource_id: monitoredProjectId
          }),
          expect.objectContaining({
            action: "PROJECT_APPROVED",
            actor_type: "USER",
            actor_label: expectedActorLabel,
            resource_type: "research_project",
            resource_id: monitoredProjectId
          }),
          expect.objectContaining({
            action: "RESEARCH_RUN_COMPLETED",
            actor_type: "USER",
            actor_label: expectedActorLabel,
            resource_type: "research_run",
            resource_id: monitoredRunId
          })
        ])
      );

      await gotoApp(page, `/runs/${monitoredRunId}`);
      const completedRunState = page.locator("section").filter({
        has: page.getByRole("heading", { level: 2, name: "Run state" })
      });
      await expect(completedRunState).toContainText("Completed");
      await expect(
        completedRunState.getByRole("progressbar", { name: "Pipeline progress" })
      ).toHaveAttribute("aria-valuenow", "100");
      await gotoApp(page, `/projects/${monitoredProjectId}/approval`);
    });

    await test.step("download and parse same-project PDF, DOCX, and ZIP artifacts", async () => {
      const pdfSubmission = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/exports/pdf`
      );
      const pdfResponse = waitForApiResponse(
        page,
        "GET",
        `/api/projects/${monitoredProjectId}/exports/pdf`
      );
      const pdfEvent = page.waitForEvent("download");
      await page.getByRole("link", { name: /^PDF\b/ }).click();
      expect((await pdfSubmission).status()).toBe(202);
      expect((await pdfResponse).status()).toBe(200);
      const pdfDownload = await pdfEvent;
      expect(pdfDownload.suggestedFilename()).toBe("final-report.pdf");
      const pdfBytes = await readDownload(pdfDownload);
      expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect((await PDFDocument.load(pdfBytes)).getPageCount()).toBeGreaterThan(0);

      const docxSubmission = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/exports/docx`
      );
      const docxResponse = waitForApiResponse(
        page,
        "GET",
        `/api/projects/${monitoredProjectId}/exports/docx`
      );
      const docxEvent = page.waitForEvent("download");
      await page.getByRole("link", { name: /^DOCX\b/ }).click();
      expect((await docxSubmission).status()).toBe(202);
      expect((await docxResponse).status()).toBe(200);
      const docxDownload = await docxEvent;
      expect(docxDownload.suggestedFilename()).toBe("final-report.docx");
      const docx = await JSZip.loadAsync(await readDownload(docxDownload));
      expect(docx.file("[Content_Types].xml")).not.toBeNull();
      const documentXml = await docx.file("word/document.xml")?.async("string");
      expect(documentXml).toContain(monitoredProjectName);

      const zipSubmission = waitForApiResponse(
        page,
        "POST",
        `/api/projects/${monitoredProjectId}/exports/zip`
      );
      const zipResponse = waitForApiResponse(
        page,
        "GET",
        `/api/projects/${monitoredProjectId}/exports/zip`
      );
      const zipEvent = page.waitForEvent("download");
      await page.getByRole("link", { name: /^ZIP\b/ }).click();
      expect((await zipSubmission).status()).toBe(202);
      expect((await zipResponse).status()).toBe(200);
      const zipDownload = await zipEvent;
      expect(zipDownload.suggestedFilename()).toBe("delivery-package.zip");
      const archive = await JSZip.loadAsync(await readDownload(zipDownload));
      const expectedFiles = [
        "final-report.md",
        "final-report.html",
        "final-report.pdf",
        "final-report.docx",
        "sources.csv",
        "claim-evidence-ledger.csv",
        "qa-findings.json",
        "project-metadata.json",
        "README.txt"
      ];
      for (const filename of expectedFiles) {
        expect(archive.file(filename), `ZIP entry ${filename}`).not.toBeNull();
      }

      const packagedReport = await archive.file("final-report.md")!.async("string");
      expect(packagedReport).toContain(generatedClaimText);
      expect(packagedReport).toContain(`[@${monitoredSourceId}]`);
      const packagedPdf = await archive.file("final-report.pdf")!.async("uint8array");
      expect((await PDFDocument.load(packagedPdf)).getPageCount()).toBeGreaterThan(0);
      const packagedDocx = await JSZip.loadAsync(
        await archive.file("final-report.docx")!.async("uint8array")
      );
      expect(packagedDocx.file("word/document.xml")).not.toBeNull();
      const metadata = JSON.parse(
        await archive.file("project-metadata.json")!.async("string")
      ) as { project?: { id?: string; name?: string }; fixture?: boolean };
      expect(metadata.project).toMatchObject({
        id: monitoredProjectId,
        name: monitoredProjectName
      });
      expect(metadata.fixture).toBe(false);
    });
  });

  test("rotates a create key when input changes and reuses a cancel key after response loss", async ({
    page
  }) => {
    test.setTimeout(240_000);
    await gotoApp(page, "/runs");
    await page.getByLabel("Approved project").selectOption(resumableProjectId);
    await page.getByLabel("Execution mode").selectOption("ASSISTED");
    const createKeys: string[] = [];
    const createModes: string[] = [];
    let createAttempts = 0;
    await page.route("**/api/runs", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      createAttempts += 1;
      createKeys.push(idempotencyKey(route.request()));
      createModes.push((route.request().postDataJSON() as { mode: string }).mode);
      if (createAttempts === 1) {
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    const createButton = page.getByRole("button", { name: "Create run" });
    await createButton.click();
    await expect(page.locator('[role="alert"][data-tone="error"]')).toBeVisible();
    await expect(createButton).toBeEnabled();
    await page.getByLabel("Execution mode").selectOption("ORCHESTRATED");
    const createResponsePromise = waitForApiResponse(page, "POST", "/api/runs");
    await createButton.click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    resumableRunId = await responseRunId(createResponse);
    await expect(page).toHaveURL(new RegExp(`/runs/${resumableRunId}$`));
    await page.unroute("**/api/runs");
    expect(createModes).toEqual(["ASSISTED", "ORCHESTRATED"]);
    expect(createKeys).toHaveLength(2);
    expect(createKeys[1]).not.toBe(createKeys[0]);
    const runState = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Run state" })
    });

    const cancelKeys: string[] = [];
    let cancelAttempts = 0;
    await page.route(`**/api/runs/${resumableRunId}/cancel`, async (route) => {
      cancelAttempts += 1;
      cancelKeys.push(idempotencyKey(route.request()));
      if (cancelAttempts === 1) {
        await route.fetch();
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    page.once("dialog", (dialog) => dialog.accept());
    const cancelButton = page.getByRole("button", { name: "Cancel run" });
    await cancelButton.click();
    await expect(page.locator('[role="alert"][data-tone="error"]')).toBeVisible();
    await expect(cancelButton).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    const cancelResponsePromise = waitForApiResponse(
      page,
      "POST",
      `/api/runs/${resumableRunId}/cancel`
    );
    await cancelButton.click();
    expect((await cancelResponsePromise).status()).toBe(200);
    await expect(
      page.getByText("Run cancellation recorded.", { exact: true })
    ).toBeVisible({ timeout: coldRouteTimeout });
    await page.unroute(`**/api/runs/${resumableRunId}/cancel`);
    expect(cancelKeys).toHaveLength(2);
    expect(cancelKeys[1]).toBe(cancelKeys[0]);
    await reloadApp(page);
    await expect(runState).toContainText("Cancelled");
    const cancellationAudits = await query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM audit_events WHERE resource_type = 'research_run' AND resource_id = $1 AND action = 'RESEARCH_RUN_CANCELLATION_REQUESTED' AND after_state->>'idempotencyKey' = $2",
      [resumableRunId, cancelKeys[0]]
    );
    expect(cancellationAudits.rows[0]?.count).toBe(1);

    const resumeResponsePromise = waitForApiResponse(
      page,
      "POST",
      `/api/runs/${resumableRunId}/resume`
    );
    await page.getByRole("button", { name: "Resume run" }).click();
    expect((await resumeResponsePromise).status()).toBe(200);
    await reloadApp(page);
    await expect(runState).toContainText("Queued");

    await executeToApproval(resumableRunId, page);
    await expect(runState).toContainText("Approval required");
    const resumed = await runSnapshot(resumableRunId);
    expect(resumed.status).toBe("APPROVAL_REQUIRED");
    expect(resumed.total_provider_requests).toBe(11);
    const resumedStages = await query<{ status: string }>(
      "SELECT status FROM research_run_stages WHERE run_id = $1",
      [resumableRunId]
    );
    expect(resumedStages.rows).toHaveLength(11);
    expect(resumedStages.rows.every((stage) => stage.status === "SUCCEEDED")).toBe(true);
  });

  test("recovers a lost worker lease without duplicating the committed evidence effect", async ({
    page
  }) => {
    test.setTimeout(240_000);
    leaseRecoveryRunId = await createRunNormally(page, leaseRecoveryProjectId);
    const recovered = await runWorkerCommand<{
      status: string;
      providerRequests: number;
      readyJobs: number;
      evidenceJob: { id: string; status: string; attempts: number } | null;
      effects: {
        evidence_count: number;
        commit_count: number;
        execution_count: number;
        lease_expiry_count: number;
      };
      runExecutionCount: number;
    }>("lease-recovery", leaseRecoveryRunId);
    expect(recovered.status).toBe("APPROVAL_REQUIRED");
    expect(recovered.providerRequests).toBe(11);
    expect(recovered.readyJobs).toBe(0);
    expect(recovered.evidenceJob).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(recovered.effects).toEqual({
      evidence_count: 1,
      commit_count: 1,
      execution_count: 1,
      lease_expiry_count: 1
    });
    expect(recovered.runExecutionCount).toBe(11);

    await reloadApp(page);
    const runState = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Run state" })
    });
    await expect(runState).toContainText("Approval required");
    const evidenceJobRow = page
      .getByRole("table", { name: "Research run jobs" })
      .getByRole("row")
      .filter({ hasText: "Evidence extraction" });
    await expect(evidenceJobRow).toContainText("Succeeded");
    await expect(evidenceJobRow).toContainText("2/3");
  });
});
