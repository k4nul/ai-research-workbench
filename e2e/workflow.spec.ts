import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import {
  expect as baseExpect,
  test,
  type Download,
  type Page,
  type Response
} from "@playwright/test";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { gotoApp, reloadApp } from "./helpers/app-ready";

test.use({ baseURL: process.env.APP_URL ?? "https://127.0.0.1:3100" });
const expect = baseExpect.configure({ timeout: 60_000 });
const execFileAsync = promisify(execFile);
const exportWorkerHelper = path.join(process.cwd(), "e2e", "helpers", "export-worker.ts");
const mutationTimeoutMs = 60_000;
let createdProjectId: string | undefined;

test.beforeEach(() => {
  createdProjectId = undefined;
});

test.afterEach(async ({ page }) => {
  if (!createdProjectId) {
    return;
  }
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "arw_csrf");
  if (!csrf) {
    throw new Error("The authenticated workflow fixture has no CSRF cookie.");
  }
  const response = await page.request.delete(
    `/api/projects/${encodeURIComponent(createdProjectId)}`,
    {
      headers: {
        origin: process.env.APP_URL ?? "https://127.0.0.1:3100",
        "x-csrf-token": csrf.value,
        "idempotency-key": `e2e-project-cleanup:${createdProjectId}`
      }
    }
  );
  expect(response.status()).toBe(200);
  createdProjectId = undefined;
});

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

function projectNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Project sections" });
}

async function performMutation(
  page: Page,
  method: "POST" | "PUT" | "PATCH",
  pathname: string,
  status: number,
  trigger: () => Promise<unknown>
): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === method &&
        new URL(candidate.url()).pathname === pathname,
      { timeout: mutationTimeoutMs }
    ),
    trigger()
  ]);
  expect(response.status(), `${method} ${pathname}`).toBe(status);
  return response;
}

async function responseResourceId(response: Response, resource: string): Promise<string> {
  const payload = (await response.json()) as { data?: { id?: unknown } };
  const id = payload.data?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`The ${resource} response did not contain an ID.`);
  }
  return id;
}

async function responseExportJobId(response: Response): Promise<string> {
  expect(response.status()).toBe(202);
  const payload = (await response.json()) as {
    data?: { job?: { id?: unknown }; queued?: unknown };
  };
  expect(payload.data?.queued).toBe(true);
  const jobId = payload.data?.job?.id;
  if (typeof jobId !== "string" || !jobId) {
    throw new Error("The export submission response did not contain a job ID.");
  }
  return jobId;
}

async function runExportWorker(jobId: string): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", exportWorkerHelper, jobId], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024
  });
}

test("completes an evidence-backed project through approval and valid exports", async ({ page }) => {
  test.setTimeout(600_000);

  const runId = randomUUID().slice(0, 8);
  const projectName = `E2E evidence workflow ${runId}`;
  const sourceTitle = `E2E primary source ${runId}`;
  const sourceSummary = "A browser-created source for deterministic workflow verification.";
  const evidenceSummary = "A traceable evidence ledger improves review clarity.";
  const claimText = "A traceable evidence ledger improves review clarity.";
  const findingText = "Traceable evidence makes the review decision easier to audit.";
  const reportTitle = `Evidence workflow report ${runId}`;
  const researchQuestion = `What evidence validates the traceable workflow ${runId}?`;
  let questionId = "";
  let sourceId = "";
  let researchDate = "";

  await test.step("create a uniquely named project", async () => {
    await gotoApp(page, "/projects/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create project" })).toBeVisible();

    await page.getByLabel("Project name").fill(projectName);
    await page
      .getByLabel("Core research question")
      .fill("How can a browser workflow preserve traceable research evidence?");
    await page.getByLabel("Purpose").fill("Verify the evidence-first workflow through the browser.");
    await page.getByLabel("Audience").fill("Quality reviewers");
    await page
      .getByLabel("In scope")
      .fill("Project intake, source review, evidence linking, report review, QA, and approval.");
    await page.getByLabel("Maximum source age (days)").fill("7300");
    researchDate = await page.getByLabel("Research as-of date").inputValue();

    const createResponse = await performMutation(
      page,
      "POST",
      "/api/projects",
      201,
      () => page.getByRole("button", { name: "Create project" }).click()
    );
    createdProjectId = await responseResourceId(createResponse, "project creation");

    await expect(page).toHaveURL(
      new RegExp(`/projects/${encodeURIComponent(createdProjectId)}$`)
    );
    await expect(page.getByRole("heading", { level: 1, name: "Project overview" })).toBeVisible();
    await expect(page.getByText(projectName, { exact: true })).toBeVisible();
  });

  await test.step("save and approve the research scope", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Scope" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Scope" })).toBeVisible();

    await page
      .getByLabel("Exclusions")
      .fill("Real customer data, production deployment, and external delivery are excluded.");
    await performMutation(
      page,
      "PATCH",
      `/api/projects/${encodeURIComponent(createdProjectId!)}`,
      200,
      () => page.getByRole("button", { name: "Save scope" }).click()
    );
    await expect(
      page.getByText(
        "Scope saved. Any prior scope, plan, QA, and approval confirmations were reset for review.",
        { exact: true },
      ),
    ).toBeVisible();

    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/scope`,
      200,
      () => page.getByRole("button", { name: "Approve scope" }).click()
    );
    await expect(page.getByText("Scope approved. Planning is now available.", { exact: true })).toBeVisible();
    await expect(page.getByText("Planning", { exact: true }).first()).toBeVisible();
  });

  await test.step("generate, save, approve, and complete the research plan", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Plan" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Research plan" })).toBeVisible();

    await page.getByRole("textbox", { exact: true, name: "Question" }).fill(researchQuestion);
    await page
      .getByLabel("Completion criteria")
      .fill("Verified evidence is linked to a supported claim and finding.");
    const questionResponse = await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/questions`,
      201,
      () => page.getByRole("button", { name: "Add question" }).click()
    );
    questionId = await responseResourceId(questionResponse, "question creation");
    await expect(page.getByText("Research question added.", { exact: true })).toBeVisible();

    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/plan`,
      200,
      () => page.getByRole("button", { name: "Generate starter plan" }).click()
    );
    await expect(page.getByText("Starter questions and plans generated.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: researchQuestion })).toBeVisible();

    const firstPlan = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 3, name: researchQuestion }) });
    const editPlanButton = firstPlan.getByRole("button", { name: "Edit plan" });
    if (await editPlanButton.isVisible()) {
      await editPlanButton.click();
    } else {
      await expect(firstPlan.getByRole("button", { name: "Hide plan" })).toBeVisible();
    }
    await firstPlan
      .getByLabel("Search strategy")
      .fill("Review authoritative primary material and compare independent corroboration.");
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/plan`,
      200,
      () => firstPlan.getByRole("button", { name: "Save plan" }).click()
    );
    await expect(firstPlan.getByText("Plan saved and returned to human review.", { exact: true })).toBeVisible();

    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/plan`,
      200,
      () => page.getByRole("button", { name: "Approve all plans" }).click()
    );
    await expect(page.getByText("All current plan items approved.", { exact: true })).toBeVisible();
    await expect(page.getByText("Researching", { exact: true }).first()).toBeVisible();

    const questionCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 3, name: researchQuestion }) });
    await questionCard.getByRole("combobox", { exact: true, name: "Status" }).selectOption("COMPLETE");
    await questionCard.getByRole("combobox", { exact: true, name: "Gap status" }).selectOption("NONE");
    await performMutation(
      page,
      "PATCH",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/questions/${encodeURIComponent(questionId)}`,
      200,
      () => questionCard.getByRole("button", { name: "Update" }).click()
    );
    await expect(questionCard.getByText("Question state updated.", { exact: true })).toBeVisible();
    await expect(questionCard.getByRole("combobox", { exact: true, name: "Status" })).toHaveValue(
      "COMPLETE",
    );
  });

  await test.step("add a source and verified evidence", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Sources" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();

    await page.getByLabel("Title").fill(sourceTitle);
    await page.getByLabel(/^URL/).fill(`https://example.com/research/${runId}`);
    await page.getByLabel("Publisher").fill("E2E Standards Office");
    await page.getByLabel("Published date").fill(researchDate);
    await page.getByLabel("Reliability grade").selectOption("A");
    await page.getByLabel("Content summary").fill(sourceSummary);
    const sourceResponse = await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/sources`,
      201,
      () => page.getByRole("button", { name: "Add source" }).click()
    );
    sourceId = await responseResourceId(sourceResponse, "source creation");

    await expect(page.getByText("Source added to this project.", { exact: true })).toBeVisible();
    const sourceLink = page
      .getByRole("table", { name: "Project sources" })
      .getByRole("link", { exact: true, name: sourceTitle });
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveAttribute(
      "href",
      `/projects/${encodeURIComponent(createdProjectId!)}/sources/${encodeURIComponent(sourceId)}`
    );
    await sourceLink.click();

    await expect(page.getByRole("heading", { level: 1, name: sourceTitle })).toBeVisible();
    await page.getByLabel("Evidence summary").fill(evidenceSummary);
    await page.getByLabel(/^Minimal quote/).fill("improves review clarity");
    await page.getByLabel("Original location").fill("Findings section");
    await page.getByLabel("Page or section").fill("Traceability controls");
    await page.getByLabel("Confidence").selectOption("HIGH");
    await page.getByLabel("Verification").selectOption("VERIFIED");
    await performMutation(
      page,
      "POST",
      `/api/sources/${encodeURIComponent(sourceId)}/evidence`,
      201,
      () => page.getByRole("button", { name: "Add evidence" }).click()
    );

    await expect(page.getByText("Evidence excerpt added to the source.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("table", { name: `Evidence from ${sourceTitle}` }).getByText(evidenceSummary, {
        exact: true,
      }),
    ).toBeVisible();
  });

  await test.step("add a claim and visibly link its evidence", async () => {
    await projectNavigation(page)
      .getByRole("link", { exact: true, name: "Claims & evidence" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Claims & evidence ledger" }),
    ).toBeVisible();

    await page.getByRole("textbox", { exact: true, name: "Claim" }).fill(claimText);
    await page
      .getByRole("combobox", { exact: true, name: "Question" })
      .selectOption({ label: researchQuestion });
    await page.getByLabel("Importance").selectOption("MEDIUM");
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/claims`,
      201,
      () => page.getByRole("button", { name: "Add claim" }).click()
    );
    await expect(
      page.getByText("Claim added. Link verified evidence before relying on it.", { exact: true }),
    ).toBeVisible();

    const evidenceLinkForm = page.locator("form").filter({
      has: page.getByRole("heading", { level: 2, name: "Link evidence" }),
    });
    await evidenceLinkForm
      .getByRole("combobox", { exact: true, name: "Claim" })
      .selectOption({ label: claimText });
    await evidenceLinkForm
      .getByRole("combobox", { exact: true, name: "Evidence" })
      .selectOption({ label: `${sourceTitle}: ${evidenceSummary}` });
    await evidenceLinkForm.getByLabel("Relationship").selectOption("SUPPORTS");
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/ledger`,
      200,
      () => evidenceLinkForm.getByRole("button", { name: "Link evidence" }).click()
    );
    await expect(
      page.getByText("Evidence relationship saved and claim support recalculated.", { exact: true }),
    ).toBeVisible();

    // Settle the two consecutive server refreshes from claim creation and evidence linking.
    await reloadApp(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Claims & evidence ledger" }),
    ).toBeVisible();

    const claimRow = page
      .getByRole("table", { name: "Claim and evidence ledger" })
      .getByRole("row")
      .filter({ hasText: claimText });
    await expect(claimRow).toContainText("Supported");
    await expect(claimRow).toContainText(evidenceSummary);
  });

  await test.step("synthesize the supported claim into a finding", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Findings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Findings" })).toBeVisible();

    await page.getByRole("textbox", { exact: true, name: "Finding" }).fill(findingText);
    await page
      .getByRole("combobox", { exact: true, name: "Research question" })
      .selectOption({ label: researchQuestion });
    await page.getByLabel("Impact").fill("Reviewers can follow the stored reasoning trail.");
    await page.getByLabel("Limitations").fill("The test uses one bounded synthetic source.");
    await page.getByRole("checkbox", { name: new RegExp(claimText) }).check();
    await page.getByRole("checkbox", { name: "This finding may inform a recommendation" }).check();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/findings`,
      201,
      () => page.getByRole("button", { name: "Add finding" }).click()
    );

    await expect(
      page.getByText("Finding created with its selected claim links.", { exact: true }),
    ).toBeVisible();
    const findingRow = page
      .getByRole("table", { name: "Project findings" })
      .getByRole("row")
      .filter({ hasText: findingText });
    await expect(findingRow).toContainText("Reviewers can follow the stored reasoning trail.");
    await expect(findingRow).toContainText("May inform");
  });

  await test.step("edit and save every required report section", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Report" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Report" })).toBeVisible();

    await page.getByLabel("Report title").fill(reportTitle);
    await page.getByLabel(/^Research purpose/).fill("Evaluate a bounded evidence review workflow.");
    await page.getByLabel(/^Executive summary/).fill("The stored evidence supports the test claim.");
    await page.getByLabel(/^Research scope/).fill("The browser workflow and its review controls are in scope.");
    await page.getByLabel(/^Methodology/).fill("Create, verify, link, review, and approve stored records.");
    await page
      .getByLabel(/^Key findings/)
      .fill(`The traceable evidence supports the reviewed claim [${sourceId}].`);
    await page
      .getByLabel(/^Detailed analysis/)
      .fill("The evidence and claim remain inspectable as separate linked records.");
    await page
      .getByLabel(/^Risks and limitations/)
      .fill("This browser run uses bounded synthetic content and one source.");
    await page
      .getByLabel(/^Recommendations/)
      .fill("Retain explicit QA and human approval before final delivery.");
    await page.getByLabel(/^References/).fill(`[${sourceId}] ${sourceTitle}.`);
    await performMutation(
      page,
      "PUT",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/deliverable`,
      200,
      () => page.getByRole("button", { name: "Save report" }).click()
    );

    await expect(page.getByText("Report saved and revision history updated.", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Report revision history" })).toContainText("User");
  });

  await test.step("run QA and record explicit human approval", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "QA" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Quality assurance" })).toBeVisible();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/qa`,
      200,
      () => page.getByRole("button", { name: "Run QA" }).click()
    );

    await expect(page.getByText("QA run completed and findings refreshed.", { exact: true })).toBeVisible();
    await expect(page.getByText("No unresolved blockers in the current finding set")).toBeVisible();
    await expect(page.getByText("No QA findings recorded", { exact: true })).toBeVisible();

    await projectNavigation(page)
      .getByRole("link", { exact: true, name: "Approval & export" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Approval & export" })).toBeVisible();
    await expect(
      page.getByText("All workflow prerequisites are ready for human approval.", { exact: true }),
    ).toBeVisible();

    const requestButton = page.getByRole("button", { name: "Request approval" });
    await expect(requestButton).toBeEnabled();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      200,
      () => requestButton.click()
    );
    await expect(page.getByText("Approval requested for human review.", { exact: true })).toBeVisible();

    const approveButton = page.getByRole("button", { name: "Approve project" });
    await expect(approveButton).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I reviewed the current report, evidence, limitations, and QA state and approve this project.",
      })
      .check();
    await expect(approveButton).toBeEnabled();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      200,
      () => approveButton.click()
    );
    await expect(page.getByText("Explicit human approval recorded.", { exact: true })).toBeVisible();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  await test.step("download and parse the PDF and final ZIP", async () => {
    const pdfEvent = page.waitForEvent("download");
    const pdfSubmission = await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/exports/pdf`,
      202,
      () => page.getByRole("link", { name: /^PDF\b/ }).click()
    );
    await responseExportJobId(pdfSubmission);
    const pdfDownload = await pdfEvent;
    expect(pdfDownload.suggestedFilename()).toBe("final-report.pdf");
    const pdfBytes = await readDownload(pdfDownload);
    expect(pdfBytes.byteLength).toBeGreaterThan(100);
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);

    const zipEvent = page.waitForEvent("download");
    const zipSubmission = await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/exports/zip`,
      202,
      () => page.getByRole("link", { name: /^ZIP\b/ }).click()
    );
    await responseExportJobId(zipSubmission);
    const zipDownload = await zipEvent;
    expect(zipDownload.suggestedFilename()).toBe("delivery-package.zip");
    const zipBytes = await readDownload(zipDownload);
    expect(zipBytes.byteLength).toBeGreaterThan(100);

    const archive = await JSZip.loadAsync(zipBytes);
    const expectedFiles = [
      "final-report.md",
      "final-report.html",
      "final-report.pdf",
      "final-report.docx",
      "sources.csv",
      "claim-evidence-ledger.csv",
      "qa-findings.json",
      "project-metadata.json",
      "README.txt",
    ];
    for (const filename of expectedFiles) {
      expect(archive.file(filename), `ZIP entry ${filename}`).not.toBeNull();
    }

    const packagedReport = await archive.file("final-report.md")!.async("string");
    expect(packagedReport).toContain(reportTitle);
    expect(packagedReport).toContain(`[${sourceId}]`);
    const packagedPdf = await archive.file("final-report.pdf")!.async("uint8array");
    expect((await PDFDocument.load(packagedPdf)).getPageCount()).toBeGreaterThan(0);
    const metadata = JSON.parse(
      await archive.file("project-metadata.json")!.async("string"),
    ) as { project?: { name?: string }; fixture?: boolean };
    expect(metadata.project?.name).toBe(projectName);
    expect(metadata.fixture).toBe(false);

    await reloadApp(page);
    await expect(page.getByRole("button", { name: "Mark delivered" })).toBeEnabled();
  });

  await test.step("invalidate approval and stale ZIP readiness after a report edit", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Report" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Report" })).toBeVisible();
    await page
      .getByLabel(/^Executive summary/)
      .fill("The stored evidence supports the test claim; this edit requires fresh review.");
    await performMutation(
      page,
      "PUT",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/deliverable`,
      200,
      () => page.getByRole("button", { name: "Save report" }).click()
    );
    await expect(page.getByText("Report saved and revision history updated.", { exact: true })).toBeVisible();

    await projectNavigation(page)
      .getByRole("link", { exact: true, name: "Approval & export" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Approval & export" })).toBeVisible();
    await expect(page.getByText("Not requested", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Complete before requesting approval: .*fresh passing QA/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request approval" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Mark delivered" })).toBeDisabled();

    await projectNavigation(page).getByRole("link", { exact: true, name: "QA" }).click();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/qa`,
      200,
      () => page.getByRole("button", { name: "Run QA" }).click()
    );
    await expect(page.getByText("QA run completed and findings refreshed.", { exact: true })).toBeVisible();
    await expect(page.getByText("No unresolved blockers in the current finding set")).toBeVisible();

    await projectNavigation(page)
      .getByRole("link", { exact: true, name: "Approval & export" })
      .click();
    await expect(
      page.getByText("All workflow prerequisites are ready for human approval.", { exact: true }),
    ).toBeVisible();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      200,
      () => page.getByRole("button", { name: "Request approval" }).click()
    );
    await expect(page.getByText("Approval requested for human review.", { exact: true })).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "I reviewed the current report, evidence, limitations, and QA state and approve this project.",
      })
      .check();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      200,
      () => page.getByRole("button", { name: "Approve project" }).click()
    );
    await expect(page.getByText("Explicit human approval recorded.", { exact: true })).toBeVisible();

    const deliverButton = page.getByRole("button", { name: "Mark delivered" });
    await expect(deliverButton).toBeEnabled();
    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      409,
      () => deliverButton.click()
    );
    await expect(page.getByText("Generate the final ZIP before delivery.", { exact: true })).toBeVisible();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    const freshZipEvent = page.waitForEvent("download");
    let freshZipSubmissionCount = 0;
    const countFreshZipSubmission = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && request.url().endsWith("/exports/zip")) {
        freshZipSubmissionCount += 1;
      }
    };
    const freshZipAction = page.locator(".export-action").filter({
      has: page.getByRole("link", { name: /^ZIP\b/ })
    });
    const [freshZipSubmission, freshZip] = await (async () => {
      page.on("request", countFreshZipSubmission);
      try {
        const submission = await performMutation(
          page,
          "POST",
          `/api/projects/${encodeURIComponent(createdProjectId!)}/exports/zip`,
          202,
          () => freshZipAction.getByRole("link", { name: /^ZIP\b/ }).dblclick()
        );
        return [submission, await freshZipEvent] as const;
      } finally {
        page.off("request", countFreshZipSubmission);
      }
    })();
    const exportJobId = await responseExportJobId(freshZipSubmission);
    expect(freshZipSubmissionCount).toBe(1);
    expect(freshZip.suggestedFilename()).toBe("delivery-package.zip");
    const refreshedArchive = await JSZip.loadAsync(await readDownload(freshZip));
    expect(refreshedArchive.file("final-report.md")).not.toBeNull();
    await expect(
      freshZipAction.getByText("Export queued and download started.", { exact: true })
    ).toBeVisible();
    await runExportWorker(exportJobId);

    await performMutation(
      page,
      "POST",
      `/api/projects/${encodeURIComponent(createdProjectId!)}/approval`,
      200,
      () => deliverButton.click()
    );
    await expect(page.getByText("Project marked delivered.", { exact: true })).toBeVisible();
    await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  });
});
