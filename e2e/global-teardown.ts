import "dotenv/config";

import { rm } from "node:fs/promises";

import { closePool, query } from "@/lib/db";

import {
  E2E_AUTH_STORAGE_STATE,
  E2E_OPERATOR_LABELS,
  E2E_OPERATOR_USERNAMES
} from "./auth-fixture";
import { assertE2ETestDatabaseConfigured } from "./database-safety";

export default async function globalTeardown(): Promise<void> {
  assertE2ETestDatabaseConfigured();
  try {
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
  } finally {
    await closePool();
    await rm(E2E_AUTH_STORAGE_STATE, { force: true });
  }
}
