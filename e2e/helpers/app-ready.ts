import type { Page } from "@playwright/test";

const appReadyTimeout = 60_000;

export async function waitForAppReady(page: Page): Promise<void> {
  await page.locator('.workbench-shell[data-app-ready="true"]').waitFor({
    state: "attached",
    timeout: appReadyTimeout
  });
}

export async function gotoApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForAppReady(page);
}

export async function gotoServerRenderedApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator(".workbench-shell").first().waitFor({
    state: "attached",
    timeout: appReadyTimeout
  });
}

export async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await waitForAppReady(page);
}
