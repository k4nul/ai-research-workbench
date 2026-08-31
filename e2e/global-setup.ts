import "dotenv/config";

import { execFile } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { FullConfig } from "@playwright/test";

import { closePool, query } from "@/lib/db";
import { createOperator, authenticateOperator } from "@/lib/services/auth";
import { resetTestDatabase } from "@/tests/helpers/database";

import {
  E2E_AUTH_OPERATOR,
  E2E_AUTH_STORAGE_STATE,
  E2E_NORMAL_OPERATOR,
  E2E_OPERATOR_LABELS,
  E2E_OPERATOR_USERNAMES
} from "./auth-fixture";
import { assertE2ETestDatabaseConfigured } from "./database-safety";

const execFileAsync = promisify(execFile);

async function removeFixtureOperators(): Promise<void> {
  await query(
    `DELETE FROM audit_events
      WHERE actor_label = ANY($1::text[])
         OR resource_id IN (
              SELECT id FROM operators WHERE normalized_username = ANY($2::text[])
              UNION ALL
              SELECT s.id FROM operator_sessions s
                JOIN operators o ON o.id = s.operator_id
               WHERE o.normalized_username = ANY($2::text[])
            )`,
    [[...E2E_OPERATOR_LABELS], [...E2E_OPERATOR_USERNAMES]]
  );
  await query(
    "DELETE FROM operators WHERE normalized_username = ANY($1::text[])",
    [[...E2E_OPERATOR_USERNAMES]]
  );
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const databaseUrl = assertE2ETestDatabaseConfigured();
  process.env.AUTH_DEMO_BYPASS = "false";
  const appUrl = new URL(config.projects[0]?.use.baseURL ?? "https://127.0.0.1:3100");
  process.env.AUTH_COOKIE_SECURE = appUrl.protocol === "https:" ? "true" : "false";
  try {
    await resetTestDatabase();
    await execFileAsync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 30_000
    });
    await removeFixtureOperators();
    await createOperator(E2E_NORMAL_OPERATOR);
    await createOperator(E2E_AUTH_OPERATOR);
    const session = await authenticateOperator({
      username: E2E_NORMAL_OPERATOR.username,
      password: E2E_NORMAL_OPERATOR.password,
      userAgent: "AI Research Workbench Playwright workflow fixture",
      clientAddress: "127.0.0.1"
    });
    const expires = Math.floor(session.expiresAt.getTime() / 1_000);
    const secure = appUrl.protocol === "https:";
    const storageStateDirectory = path.dirname(E2E_AUTH_STORAGE_STATE);
    await mkdir(storageStateDirectory, { recursive: true, mode: 0o700 });
    await chmod(storageStateDirectory, 0o700);
    await rm(E2E_AUTH_STORAGE_STATE, { force: true });
    await writeFile(
      E2E_AUTH_STORAGE_STATE,
      JSON.stringify({
        cookies: [
          {
            name: "arw_session",
            value: session.sessionToken,
            domain: appUrl.hostname,
            path: "/",
            expires,
            httpOnly: true,
            secure,
            sameSite: "Strict"
          },
          {
            name: "arw_csrf",
            value: session.csrfToken,
            domain: appUrl.hostname,
            path: "/",
            expires,
            httpOnly: false,
            secure,
            sameSite: "Strict"
          }
        ],
        origins: []
      }),
      { flag: "wx", mode: 0o600 }
    );
    if (((await stat(E2E_AUTH_STORAGE_STATE)).mode & 0o777) !== 0o600) {
      throw new Error("Playwright authentication storage must use mode 0600.");
    }
  } finally {
    await closePool();
  }
}
