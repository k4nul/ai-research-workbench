import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

const sampleProjectName = "[SAMPLE] Research workbench adoption feasibility";
const rawAppUrl = process.env.APP_URL?.trim() || "http://localhost:3100";

function parseAppUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`APP_URL must be an absolute URL, received ${JSON.stringify(value)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`APP_URL must use HTTP or HTTPS, received ${parsed.protocol}.`);
  }
  return parsed;
}

async function requireHeading(page: Page, name: string, route: string) {
  const heading = page.getByRole("heading", { level: 1, name });
  try {
    await heading.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(`Expected the ${JSON.stringify(name)} page heading at ${route}, but it never became visible.`);
  }
}

async function captureScreenshots() {
  const appUrl = parseAppUrl(rawAppUrl);
  const outputDirectory = path.resolve(process.cwd(), "docs/screenshots");
  const dashboardPath = path.join(outputDirectory, "dashboard.png");
  const projectOverviewPath = path.join(outputDirectory, "project-overview.png");
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: 1000, width: 1440 },
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });

    const dashboardUrl = new URL("/", appUrl).toString();
    try {
      await page.goto(dashboardUrl, { timeout: 30_000, waitUntil: "networkidle" });
    } catch (error) {
      throw new Error(
        `Could not load the running workbench at ${dashboardUrl}. Start the app and verify APP_URL. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await requireHeading(page, "Dashboard", dashboardUrl);

    const sampleLink = page
      .getByRole("table", { name: "Recent projects" })
      .getByRole("link", { exact: true, name: sampleProjectName });
    if (!(await sampleLink.isVisible())) {
      throw new Error(
        `The seeded sample project ${JSON.stringify(sampleProjectName)} is not visible on the dashboard. Reset/seed the demo database before capturing documentation screenshots.`,
      );
    }

    await mkdir(outputDirectory, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      path: dashboardPath,
    });

    await sampleLink.click();
    const expectedProjectUrl = new URL("/projects/project-demo", appUrl).toString();
    await requireHeading(page, "Project overview", expectedProjectUrl);
    if (!page.url().endsWith("/projects/project-demo")) {
      throw new Error(`The sample project link opened ${page.url()} instead of ${expectedProjectUrl}.`);
    }
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      path: projectOverviewPath,
    });

    process.stdout.write(`Captured ${dashboardPath}\nCaptured ${projectOverviewPath}\n`);
  } finally {
    await browser.close();
  }
}

captureScreenshots().catch((error: unknown) => {
  process.stderr.write(
    `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
