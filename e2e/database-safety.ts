const DEFAULT_E2E_TEST_DATABASE_URL =
  "postgresql://research:research@localhost:55432/research_workbench_test";

type E2EDatabaseEnvironment = Record<string, string | undefined>;

function validatedTestDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL for browser tests.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres or postgresql protocol.");
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("TEST_DATABASE_URL contains an invalid database name.");
  }
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error("TEST_DATABASE_URL must name an explicit test database.");
  }
  return value;
}

export function resolveE2ETestDatabaseUrl(
  env: E2EDatabaseEnvironment = process.env
): string {
  return validatedTestDatabaseUrl(
    env.TEST_DATABASE_URL?.trim() || DEFAULT_E2E_TEST_DATABASE_URL
  );
}

export function configureE2ETestDatabase(
  env: E2EDatabaseEnvironment = process.env
): string {
  const databaseUrl = resolveE2ETestDatabaseUrl(env);
  env.TEST_DATABASE_URL = databaseUrl;
  env.DATABASE_URL = databaseUrl;
  return databaseUrl;
}

export function assertE2ETestDatabaseConfigured(
  env: E2EDatabaseEnvironment = process.env
): string {
  const testDatabaseUrl = resolveE2ETestDatabaseUrl(env);
  if (env.DATABASE_URL?.trim() !== testDatabaseUrl) {
    throw new Error(
      "Browser tests require DATABASE_URL to equal the validated TEST_DATABASE_URL."
    );
  }
  return testDatabaseUrl;
}
