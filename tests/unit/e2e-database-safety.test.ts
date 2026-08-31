import { describe, expect, it } from "vitest";

import {
  assertE2ETestDatabaseConfigured,
  configureE2ETestDatabase,
  resolveE2ETestDatabaseUrl
} from "@/e2e/database-safety";

describe("Playwright database safety", () => {
  it("points both database variables at the explicit test database", () => {
    const env = {
      DATABASE_URL: "postgresql://example.invalid/research_workbench",
      TEST_DATABASE_URL: "postgresql://example.invalid/research_workbench_e2e_test"
    };

    expect(configureE2ETestDatabase(env)).toBe(env.TEST_DATABASE_URL);
    expect(env.DATABASE_URL).toBe(env.TEST_DATABASE_URL);
    expect(assertE2ETestDatabaseConfigured(env)).toBe(env.TEST_DATABASE_URL);
  });

  it.each([
    "postgresql://example.invalid/research_workbench",
    "https://example.invalid/research_workbench_test",
    "not a database URL"
  ])("rejects an unsafe TEST_DATABASE_URL: %s", (testDatabaseUrl) => {
    expect(() =>
      resolveE2ETestDatabaseUrl({ TEST_DATABASE_URL: testDatabaseUrl })
    ).toThrow();
  });

  it("rejects a mismatched runtime DATABASE_URL", () => {
    expect(() =>
      assertE2ETestDatabaseConfigured({
        DATABASE_URL: "postgresql://example.invalid/research_workbench",
        TEST_DATABASE_URL: "postgresql://example.invalid/research_workbench_test"
      })
    ).toThrow(/DATABASE_URL to equal/);
  });
});
