import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { closePool, query } from "@/lib/db";
import { submitJob } from "@/lib/services/jobs";
import { createProject } from "@/lib/services/projects";

import { gotoApp } from "./helpers/app-ready";

test.use({
  baseURL: process.env.APP_URL ?? "https://127.0.0.1:3100",
  browserName: "chromium",
});

let mobileProjectId = "";
let mobileJobId = "";
let mobileJobType = "";

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function createMobileApprovalFixture(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const project = await createProject({
    mode: "detailed",
    name: `E2E mobile approval ${suffix}`,
    clientName: "E2E mobile fixture",
    coreQuestion: "Can a mobile operator safely approve and cancel synthetic work?",
    background: "Synthetic mobile browser fixture.",
    purpose: "Verify mobile approval and durable cancellation controls.",
    audience: "Test operator",
    scope: "Mobile approval and cancellation controls.",
    exclusions: "Live providers, customer data, and external delivery.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF", "DOCX", "ZIP"],
    specialRequirements: "Use synthetic fixtures only."
  });
  mobileProjectId = project.id;
  const questionId = randomUUID();
  const sourceId = randomUUID();
  const evidenceId = randomUUID();
  const claimId = randomUUID();
  const findingId = randomUUID();
  const sourceTitle = `Mobile control fixture ${suffix}`;
  await query(
    `INSERT INTO research_questions (
       id, project_id, question, priority, status, completion_criteria, gap_status
     ) VALUES ($1, $2, 'What evidence supports mobile operator controls?', 'HIGH',
       'COMPLETE', 'One verified synthetic source is linked.', 'NONE')`,
    [questionId, project.id]
  );
  await query(
    `INSERT INTO research_plans (
       id, project_id, question_id, search_strategy, search_queries,
       primary_source_types, secondary_source_types, comparison_targets,
       expected_output, completion_condition, expected_risks, ai_suggested,
       human_approved, approved_at
     ) VALUES ($1, $2, $3, 'Use the bounded synthetic fixture.',
       ARRAY['mobile operator control fixture'], ARRAY['PRIMARY_GUIDANCE'],
       ARRAY[]::text[], ARRAY['desktop controls'], 'A supported synthetic claim.',
       'Verified evidence is linked.', ARRAY['fixture only'], FALSE, TRUE, NOW())`,
    [randomUUID(), project.id, questionId]
  );
  await query(
    `INSERT INTO sources (
       id, project_id, url, title, publisher, published_at, source_type, language,
       reliability_grade, freshness_status, ingestion_method, mime_type,
       content_summary, sanitized_content
     ) VALUES ($1, $2, $3, $4, 'Fixture Standards Office', '2026-08-30',
       'PRIMARY_GUIDANCE', 'en', 'A', 'CURRENT', 'IMPORT', 'text/plain', $5, $5)`,
    [
      sourceId,
      project.id,
      `https://example.com/mobile-fixture/${suffix}`,
      sourceTitle,
      "Explicit mobile controls preserve an auditable operator decision."
    ]
  );
  await query(
    `INSERT INTO evidence (
       id, source_id, summary, minimal_quote, confidence, verification_status
     ) VALUES ($1, $2, $3, 'preserve an auditable operator decision', 'HIGH', 'VERIFIED')`,
    [
      evidenceId,
      sourceId,
      "Explicit mobile controls preserve an auditable operator decision."
    ]
  );
  await query(
    `INSERT INTO claims (
       id, project_id, question_id, content, claim_type, importance, support_status,
       fact_or_inference, verification_possible, within_scope, include_in_report
     ) VALUES ($1, $2, $3, $4, 'FACT', 'HIGH', 'SUPPORTED', 'FACT', TRUE, TRUE, TRUE)`,
    [
      claimId,
      project.id,
      questionId,
      "Explicit mobile controls preserve an auditable operator decision."
    ]
  );
  await query(
    "INSERT INTO claim_evidence (claim_id, evidence_id, relationship) VALUES ($1, $2, 'SUPPORTS')",
    [claimId, evidenceId]
  );
  await query(
    `INSERT INTO findings (
       id, project_id, question_id, finding, importance, impact, limitations,
       can_inform_recommendation
     ) VALUES ($1, $2, $3, $4, 'HIGH', 'A test operator can review the decision trail.',
       'Synthetic browser fixture only.', TRUE)`,
    [
      findingId,
      project.id,
      questionId,
      "The synthetic evidence supports an explicit mobile decision trail."
    ]
  );
  await query(
    "INSERT INTO finding_claims (finding_id, claim_id) VALUES ($1, $2)",
    [findingId, claimId]
  );
  const sections = {
    researchPurpose: "Verify mobile approval and cancellation controls.",
    executiveSummary: "The bounded fixture supports the mobile control claim.",
    researchScope: "Synthetic mobile operator controls only.",
    methodology: "Link one verified fixture to one reportable claim.",
    keyFindings: `Explicit controls preserve the decision trail [${sourceId}].`,
    detailedAnalysis: "The evidence, claim, and finding remain separately inspectable.",
    comparisonTable: "",
    risksAndLimitations: "This is synthetic browser evidence.",
    recommendations: "Retain explicit confirmation for human approval.",
    references: `[${sourceId}] ${sourceTitle}`,
    appendix: ""
  };
  await query(
    `UPDATE deliverables
     SET title = $2, sections = $3::jsonb, updated_at = NOW()
     WHERE project_id = $1 AND version = 1`,
    [project.id, `Mobile approval report ${suffix}`, JSON.stringify(sections)]
  );
  await query(
    `UPDATE research_projects
     SET scope_approved_at = NOW(), plan_approved_at = NOW(), qa_passed_at = NOW(),
         status = 'APPROVAL_REQUIRED', progress = 90, updated_at = NOW()
     WHERE id = $1`,
    [project.id]
  );

  mobileJobType = `E2E_MOBILE_CANCEL_${suffix}`;
  mobileJobId = (
    await submitJob({
      projectId: project.id,
      jobType: mobileJobType,
      inputReference: { fixture: "playwright-mobile-cancel" },
      idempotencyKey: `e2e-mobile-cancel:${suffix}`
    })
  ).job.id;
}

test.afterEach(async () => {
  if (!mobileProjectId) return;
  try {
    await query("DELETE FROM research_projects WHERE id = $1", [mobileProjectId]);
  } finally {
    mobileProjectId = "";
    mobileJobId = "";
    mobileJobType = "";
    await closePool();
  }
});

test("keeps mobile navigation contained and records isolated approval and cancellation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "This check targets the configured mobile viewport.");
  test.setTimeout(180_000);
  await createMobileApprovalFixture();

  await gotoApp(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();

  const menu = page.getByRole("dialog", { name: "Main menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(menu.getByRole("link", { exact: true, name: "Projects" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await menu.getByRole("link", { exact: true, name: "Projects" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(menu).toBeHidden();
  await expectNoHorizontalOverflow(page);

  await gotoApp(page, `/projects/${mobileProjectId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Project overview" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { exact: true, name: "Approval & export" })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Approval & export" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const exportHeading = page.getByRole("heading", { name: "Export deliverables" });
  await exportHeading.scrollIntoViewIfNeeded();
  await expect(exportHeading).toBeInViewport();

  const pdfLink = page.getByRole("link", { name: /^PDF\b/ });
  const zipLink = page.getByRole("link", { name: /^ZIP\b/ });
  await pdfLink.scrollIntoViewIfNeeded();
  await expect(pdfLink).toBeInViewport();
  await zipLink.scrollIntoViewIfNeeded();
  await expect(zipLink).toBeInViewport();

  const requestButton = page.getByRole("button", { name: "Request approval" });
  const approveButton = page.getByRole("button", { name: "Approve project" });
  await requestButton.scrollIntoViewIfNeeded();
  await expect(requestButton).toBeInViewport();
  await expect(requestButton).toBeEnabled();
  const requestResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/projects/${mobileProjectId}/approval`)
  );
  await requestButton.click();
  expect((await requestResponse).status()).toBe(200);
  await expect(page.getByText("Approval requested for human review.", { exact: true })).toBeVisible();

  await approveButton.scrollIntoViewIfNeeded();
  await expect(approveButton).toBeInViewport();
  await expect(approveButton).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I reviewed the current report, evidence, limitations, and QA state and approve this project."
    })
    .check();
  await expect(approveButton).toBeEnabled();
  const approveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/projects/${mobileProjectId}/approval`)
  );
  await approveButton.click();
  expect((await approveResponse).status()).toBe(200);
  await expect(page.getByText("Explicit human approval recorded.", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const result = await query<{ status: string; approval_status: string }>(
        "SELECT status, approval_status FROM research_projects WHERE id = $1",
        [mobileProjectId]
      );
      return result.rows[0];
    })
    .toEqual({ status: "APPROVED", approval_status: "APPROVED" });
  await expectNoHorizontalOverflow(page);

  await gotoApp(page, `/jobs?projectId=${encodeURIComponent(mobileProjectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Job queue" })).toBeVisible();
  const jobRow = page
    .getByRole("table", { name: "Durable jobs" })
    .getByRole("row")
    .filter({ hasText: mobileJobType });
  await expect(jobRow).toContainText("Queued");
  await expectNoHorizontalOverflow(page);
  page.once("dialog", (dialog) => dialog.accept());
  const cancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/jobs/${mobileJobId}/cancel`)
  );
  await jobRow.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await cancelResponse).status()).toBe(200);
  await expect(jobRow).toContainText("Cancelled");
  await expect
    .poll(async () => {
      const result = await query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
        mobileJobId
      ]);
      return result.rows[0]?.status;
    })
    .toBe("CANCELLED");
  await expectNoHorizontalOverflow(page);
});
