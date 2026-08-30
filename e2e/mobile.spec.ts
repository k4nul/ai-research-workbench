import { expect, test } from "@playwright/test";

test.use({
  baseURL: process.env.APP_URL ?? "http://localhost:3100",
  browserName: "chromium",
});

test("keeps navigation and approval controls reachable on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "This check targets the configured mobile viewport.");
  test.setTimeout(90_000);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();

  const menu = page.getByRole("dialog", { name: "Main menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(menu.getByRole("link", { exact: true, name: "Projects" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await menu.getByRole("link", { exact: true, name: "Projects" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(menu).toBeHidden();

  await page.goto("/projects/project-demo");
  await expect(page.getByRole("heading", { level: 1, name: "Project overview" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { exact: true, name: "Approval & export" })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Approval & export" })).toBeVisible();
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
  await approveButton.scrollIntoViewIfNeeded();
  await expect(approveButton).toBeInViewport();
});
