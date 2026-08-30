import { randomUUID } from "node:crypto";

import { expect as baseExpect, test, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

test.use({ baseURL: process.env.APP_URL ?? "http://localhost:3100" });
const expect = baseExpect.configure({ timeout: 60_000 });
let createdProjectId: string | undefined;

test.beforeEach(() => {
  createdProjectId = undefined;
});

test.afterEach(async ({ request }) => {
  if (!createdProjectId) {
    return;
  }
  const response = await request.delete(
    `/api/projects/${encodeURIComponent(createdProjectId)}`,
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
  let sourceId = "";
  let researchDate = "";

  await test.step("create a uniquely named project", async () => {
    await page.goto("/projects/new");
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

    await page.getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/\/projects\/(?!new(?:[/?#]|$))[A-Za-z0-9-]+$/);
    const projectMatch = new URL(page.url()).pathname.match(/^\/projects\/([^/]+)$/);
    if (!projectMatch) {
      throw new Error(`Could not determine a project ID from UI URL ${page.url()}.`);
    }
    createdProjectId = decodeURIComponent(projectMatch[1]);
    await expect(page.getByRole("heading", { level: 1, name: "Project overview" })).toBeVisible();
    await expect(page.getByText(projectName, { exact: true })).toBeVisible();
  });

  await test.step("save and approve the research scope", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Scope" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Scope" })).toBeVisible();

    await page
      .getByLabel("Exclusions")
      .fill("Real customer data, production deployment, and external delivery are excluded.");
    await page.getByRole("button", { name: "Save scope" }).click();
    await expect(
      page.getByText(
        "Scope saved. Any prior scope, plan, QA, and approval confirmations were reset for review.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.getByRole("button", { name: "Approve scope" }).click();
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
    await page.getByRole("button", { name: "Add question" }).click();
    await expect(page.getByText("Research question added.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Generate starter plan" }).click();
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
    await firstPlan.getByRole("button", { name: "Save plan" }).click();
    await expect(firstPlan.getByText("Plan saved and returned to human review.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Approve all plans" }).click();
    await expect(page.getByText("All current plan items approved.", { exact: true })).toBeVisible();
    await expect(page.getByText("Researching", { exact: true }).first()).toBeVisible();

    const questionCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 3, name: researchQuestion }) });
    await questionCard.getByRole("combobox", { exact: true, name: "Status" }).selectOption("COMPLETE");
    await questionCard.getByRole("combobox", { exact: true, name: "Gap status" }).selectOption("NONE");
    await questionCard.getByRole("button", { name: "Update" }).click();
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
    await page.getByRole("button", { name: "Add source" }).click();

    await expect(page.getByText("Source added to this project.", { exact: true })).toBeVisible();
    const sourceLink = page
      .getByRole("table", { name: "Project sources" })
      .getByRole("link", { exact: true, name: sourceTitle });
    await expect(sourceLink).toBeVisible();
    const sourceHref = await sourceLink.getAttribute("href");
    const sourceMatch = sourceHref?.match(/\/sources\/([^/?#]+)$/);
    if (!sourceMatch) {
      throw new Error(`Could not determine a source ID from UI link ${String(sourceHref)}.`);
    }
    sourceId = decodeURIComponent(sourceMatch[1]);
    await sourceLink.click();

    await expect(page.getByRole("heading", { level: 1, name: sourceTitle })).toBeVisible();
    await page.getByLabel("Evidence summary").fill(evidenceSummary);
    await page.getByLabel(/^Minimal quote/).fill("improves review clarity");
    await page.getByLabel("Original location").fill("Findings section");
    await page.getByLabel("Page or section").fill("Traceability controls");
    await page.getByLabel("Confidence").selectOption("HIGH");
    await page.getByLabel("Verification").selectOption("VERIFIED");
    await page.getByRole("button", { name: "Add evidence" }).click();

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
    await page.getByRole("button", { name: "Add claim" }).click();
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
    await evidenceLinkForm.getByRole("button", { name: "Link evidence" }).click();
    await expect(
      page.getByText("Evidence relationship saved and claim support recalculated.", { exact: true }),
    ).toBeVisible();

    // Settle the two consecutive server refreshes from claim creation and evidence linking.
    await page.reload();
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
    await page.getByRole("button", { name: "Add finding" }).click();

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
    await page.getByRole("button", { name: "Save report" }).click();

    await expect(page.getByText("Report saved and revision history updated.", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Report revision history" })).toContainText("User");
  });

  await test.step("run QA and record explicit human approval", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "QA" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Quality assurance" })).toBeVisible();
    await page.getByRole("button", { name: "Run QA" }).click();

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
    await requestButton.click();
    await expect(page.getByText("Approval requested for human review.", { exact: true })).toBeVisible();

    const approveButton = page.getByRole("button", { name: "Approve project" });
    await expect(approveButton).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I reviewed the current report, evidence, limitations, and QA state and approve this project.",
      })
      .check();
    await expect(approveButton).toBeEnabled();
    await approveButton.click();
    await expect(page.getByText("Explicit human approval recorded.", { exact: true })).toBeVisible();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  await test.step("download and parse the PDF and final ZIP", async () => {
    const pdfEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: /^PDF\b/ }).click();
    const pdfDownload = await pdfEvent;
    expect(pdfDownload.suggestedFilename()).toBe("final-report.pdf");
    const pdfBytes = await readDownload(pdfDownload);
    expect(pdfBytes.byteLength).toBeGreaterThan(100);
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);

    const zipEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: /^ZIP\b/ }).click();
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

    await page.reload();
    await expect(page.getByRole("button", { name: "Mark delivered" })).toBeEnabled();
  });

  await test.step("invalidate approval and stale ZIP readiness after a report edit", async () => {
    await projectNavigation(page).getByRole("link", { exact: true, name: "Report" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Report" })).toBeVisible();
    await page
      .getByLabel(/^Executive summary/)
      .fill("The stored evidence supports the test claim; this edit requires fresh review.");
    await page.getByRole("button", { name: "Save report" }).click();
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
    await page.getByRole("button", { name: "Run QA" }).click();
    await expect(page.getByText("QA run completed and findings refreshed.", { exact: true })).toBeVisible();
    await expect(page.getByText("No unresolved blockers in the current finding set")).toBeVisible();

    await projectNavigation(page)
      .getByRole("link", { exact: true, name: "Approval & export" })
      .click();
    await expect(
      page.getByText("All workflow prerequisites are ready for human approval.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Request approval" }).click();
    await expect(page.getByText("Approval requested for human review.", { exact: true })).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "I reviewed the current report, evidence, limitations, and QA state and approve this project.",
      })
      .check();
    await page.getByRole("button", { name: "Approve project" }).click();
    await expect(page.getByText("Explicit human approval recorded.", { exact: true })).toBeVisible();

    const deliverButton = page.getByRole("button", { name: "Mark delivered" });
    await expect(deliverButton).toBeEnabled();
    await deliverButton.click();
    await expect(page.getByText("Generate the final ZIP before delivery.", { exact: true })).toBeVisible();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    const freshZipEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: /^ZIP\b/ }).click();
    const freshZip = await freshZipEvent;
    expect(freshZip.suggestedFilename()).toBe("delivery-package.zip");
    const refreshedArchive = await JSZip.loadAsync(await readDownload(freshZip));
    expect(refreshedArchive.file("final-report.md")).not.toBeNull();

    await deliverButton.click();
    await expect(page.getByText("Project marked delivered.", { exact: true })).toBeVisible();
    await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  });
});
