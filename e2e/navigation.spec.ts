import { expect, test } from "@playwright/test";

const sampleProjectName = "[SAMPLE] Research workbench adoption feasibility";

test.use({ baseURL: process.env.APP_URL ?? "http://localhost:3100" });

test("navigates from the dashboard to the seeded demo project", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Workspace metrics" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Recent projects" })).toBeVisible();

  await page.getByRole("link", { name: "View all projects" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

  await page.getByRole("searchbox", { exact: true, name: "Search projects" }).fill(sampleProjectName);
  await page.getByRole("button", { name: "Apply filters" }).click();

  const projectTable = page.getByRole("table", { name: "Research projects" });
  const sampleProjectLink = projectTable.getByRole("link", {
    exact: true,
    name: sampleProjectName,
  });
  await expect(sampleProjectLink).toBeVisible();
  await sampleProjectLink.click();

  await expect(page).toHaveURL(/\/projects\/project-demo$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Project overview" })).toBeVisible();
  await expect(page.getByText(sampleProjectName, { exact: true })).toBeVisible();
});
