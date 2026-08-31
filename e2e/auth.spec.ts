import { expect, test, type Page } from "@playwright/test";

import { validateAuthRuntime } from "@/lib/auth/runtime";

import { E2E_AUTH_OPERATOR } from "./auth-fixture";
import { gotoApp, gotoServerRenderedApp, waitForAppReady } from "./helpers/app-ready";

const coldRouteTimeout = 15_000;
const authResponseTimeout = 60_000;

async function signIn(page: Page): Promise<void> {
  await gotoApp(page, "/login");
  await page.getByLabel("Username").fill(E2E_AUTH_OPERATOR.username);
  await page.getByLabel("Password").fill(E2E_AUTH_OPERATOR.password);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/auth/login",
    { timeout: authResponseTimeout }
  );
  const loginNavigationPromise = page.waitForURL(
    (url) => url.pathname === "/" && url.search === "",
    { timeout: authResponseTimeout, waitUntil: "domcontentloaded" }
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.request().method()).toBe("POST");
  expect(new URL(loginResponse.url()).pathname).toBe("/api/auth/login");
  expect(loginResponse.status()).toBe(200);
  await loginNavigationPromise;
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({
    timeout: coldRouteTimeout
  });
}

test.describe.serial("operator authentication without demo bypass", () => {
  test("blocks anonymous access, authenticates, revokes a session, and logs out", async ({
    browser,
    page
  }) => {
    test.setTimeout(240_000);

    const anonymousApi = await page.request.get("/api/dashboard");
    expect(anonymousApi.status()).toBe(401);
    await expect(anonymousApi.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });

    await gotoApp(page, "/projects");
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/, {
      timeout: coldRouteTimeout
    });
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible({
      timeout: coldRouteTimeout
    });

    await signIn(page);
    const protectedApi = await page.request.get("/api/dashboard");
    expect(protectedApi.status()).toBe(200);

    const secondContext = await browser.newContext({
      baseURL: process.env.APP_URL ?? "https://127.0.0.1:3100",
      ignoreHTTPSErrors: true,
      userAgent: "AI Research Workbench revocation fixture"
    });
    const secondPage = await secondContext.newPage();
    await signIn(secondPage);

    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions$/, { timeout: coldRouteTimeout });
    await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible({
      timeout: coldRouteTimeout
    });
    const revocationTarget = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        level: 3,
        name: "AI Research Workbench revocation fixture"
      })
    });
    const revokeResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /^\/api\/auth\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          new URL(response.url()).pathname
        ),
      { timeout: authResponseTimeout }
    );
    await revocationTarget.getByRole("button", { name: "Revoke session", exact: true }).click();
    const revokeResponse = await revokeResponsePromise;
    expect(revokeResponse.request().method()).toBe("DELETE");
    expect(new URL(revokeResponse.url()).pathname).toMatch(
      /^\/api\/auth\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(revokeResponse.status()).toBe(200);
    await expect(page.getByText("Session revoked.", { exact: true })).toBeVisible({
      timeout: coldRouteTimeout
    });

    const revokedApi = await secondPage.request.get("/api/dashboard");
    expect(revokedApi.status()).toBe(401);
    await gotoApp(secondPage, "/projects");
    await expect(secondPage).toHaveURL(/\/login$/, { timeout: coldRouteTimeout });
    await secondContext.close();

    const logoutResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/logout",
      { timeout: authResponseTimeout }
    );
    const logoutNavigationPromise = page.waitForURL(
      (url) => url.pathname === "/login" && url.search === "",
      { timeout: authResponseTimeout, waitUntil: "domcontentloaded" }
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const logoutResponse = await logoutResponsePromise;
    expect(logoutResponse.request().method()).toBe("POST");
    expect(new URL(logoutResponse.url()).pathname).toBe("/api/auth/logout");
    expect(logoutResponse.status()).toBe(200);
    await logoutNavigationPromise;
    await waitForAppReady(page);
    expect((await page.request.get("/api/dashboard")).status()).toBe(401);
  });

  test("states the JavaScript requirement without showing an unusable login", async ({
    browser
  }) => {
    const context = await browser.newContext({
      baseURL: process.env.APP_URL ?? "https://127.0.0.1:3100",
      ignoreHTTPSErrors: true,
      javaScriptEnabled: false
    });
    try {
      const page = await context.newPage();
      await gotoServerRenderedApp(page, "/login");
      await expect(
        page.locator('form[method="post"]:visible')
      ).toHaveCount(0);
      await expect(
        page.getByText("JavaScript is required to use AI Research Workbench.", {
          exact: true
        })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("rejects bypass in production and on public hosts", () => {
    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "production",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        AUTH_COOKIE_SECURE: "true",
        AUTH_SESSION_SECRET: "production-auth-session-secret-fixture",
        APP_URL: "https://localhost:3100"
      })
    ).toThrow("Authentication bypass is forbidden in production.");

    expect(() =>
      validateAuthRuntime({
        NODE_ENV: "test",
        DEMO_MODE: "true",
        AUTH_ENABLED: "true",
        AUTH_DEMO_BYPASS: "true",
        AUTH_COOKIE_SECURE: "false",
        APP_URL: "http://workbench.example.com"
      })
    ).toThrow("Authentication bypass is allowed only on a loopback APP_URL.");
  });
});
