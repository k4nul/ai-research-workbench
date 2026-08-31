import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as createProjectRoute } from "@/app/api/projects/route";
import { closePool, query } from "@/lib/db";
import {
  executeIdempotentMutation,
  executeIdempotentResponse
} from "@/lib/services/mutation-receipts";
import { resetTestDatabase } from "@/tests/helpers/database";

const origin = "http://localhost:3100";

function intake(name: string) {
  return {
    mode: "detailed",
    name,
    clientName: "Mutation receipt fixture",
    coreQuestion: "Can one response-loss retry create exactly one project?",
    background: "Synthetic idempotency integration fixture.",
    purpose: "Verify atomic mutation receipts.",
    audience: "Test reviewer",
    scope: "Synthetic database records only.",
    exclusions: "External provider and customer data.",
    jurisdiction: "Test jurisdiction",
    researchDate: "2026-08-31",
    sourceMaxAgeDays: 365,
    deadline: "2026-09-30",
    deliverableFormats: ["MARKDOWN", "PDF"],
    specialRequirements: "No external effects."
  };
}

function request(key: string | undefined, body: unknown, query = ""): Request {
  return new Request(`${origin}/api/projects${query}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {})
    },
    body: JSON.stringify(body)
  });
}

async function effectCounts() {
  const result = await query<{
    projects: number;
    deliverables: number;
    audits: number;
    receipts: number;
  }>(`SELECT
      (SELECT COUNT(*)::integer FROM research_projects) AS projects,
      (SELECT COUNT(*)::integer FROM deliverables) AS deliverables,
      (SELECT COUNT(*)::integer FROM audit_events WHERE action = 'PROJECT_CREATED') AS audits,
      (SELECT COUNT(*)::integer FROM mutation_receipts) AS receipts`);
  return result.rows[0];
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("atomic authenticated mutation receipts", () => {
  it("requires a validated idempotency key before mutating", async () => {
    const response = await createProjectRoute(request(undefined, intake("Missing key")));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
    await expect(effectCounts()).resolves.toEqual({
      projects: 0,
      deliverables: 0,
      audits: 0,
      receipts: 0
    });
  });

  it("replays the exact successful response after response loss and rejects input drift", async () => {
    const key = "project-response-loss-1";
    const first = await createProjectRoute(
      request(key, intake("Response loss project"), "?filter=one&a=1&a=2")
    );
    const firstBody = await first.text();
    expect(first.status).toBe(201);

    const replay = await createProjectRoute(
      request(key, intake("Response loss project"), "?filter=one&a=1&a=2")
    );
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstBody);
    await expect(effectCounts()).resolves.toEqual({
      projects: 1,
      deliverables: 1,
      audits: 1,
      receipts: 1
    });

    const queryDrift = await createProjectRoute(
      request(key, intake("Response loss project"), "?filter=one&a=2&a=1")
    );
    expect(queryDrift.status).toBe(409);
    await expect(queryDrift.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });

    const drift = await createProjectRoute(
      request(key, intake("Different project input"), "?filter=one&a=1&a=2")
    );
    expect(drift.status).toBe(409);
    await expect(drift.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
    await expect(effectCounts()).resolves.toEqual({
      projects: 1,
      deliverables: 1,
      audits: 1,
      receipts: 1
    });
  });

  it("serializes concurrent duplicate requests into one domain and audit effect", async () => {
    const key = "project-concurrent-request-1";
    const body = intake("Concurrent project");
    const [left, right] = await Promise.all([
      createProjectRoute(request(key, body)),
      createProjectRoute(request(key, body))
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(await left.text()).toBe(await right.text());
    await expect(effectCounts()).resolves.toEqual({
      projects: 1,
      deliverables: 1,
      audits: 1,
      receipts: 1
    });
  });

  it("scopes the same method, path, and key independently to each principal", async () => {
    let operations = 0;
    const execute = (principalScope: string) =>
      executeIdempotentMutation(
        {
          principalScope,
          method: "POST",
          requestPath: "/api/principal-scope-fixture",
          idempotencyKey: "shared-principal-fixture",
          requestHash: "b".repeat(64)
        },
        201,
        async () => ({ principalScope, operation: ++operations })
      );

    const first = await execute("operator:first");
    const second = await execute("operator:second");
    const replay = await execute("operator:first");

    expect(first.responseStatus).toBe(201);
    expect(second.responseStatus).toBe(201);
    expect(second.responseBody).not.toBe(first.responseBody);
    expect(replay.responseBody).toBe(first.responseBody);
    expect(replay.replayed).toBe(true);
    expect(operations).toBe(2);
    await expect(
      query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM mutation_receipts WHERE request_path = '/api/principal-scope-fixture'"
      )
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("rolls back the receipt when validation rejects the mutation", async () => {
    const key = "project-validation-retry-1";
    const invalid = await createProjectRoute(request(key, { ...intake("Invalid"), scope: "" }));
    expect(invalid.status).toBe(400);
    await expect(effectCounts()).resolves.toEqual({
      projects: 0,
      deliverables: 0,
      audits: 0,
      receipts: 0
    });

    const valid = await createProjectRoute(request(key, intake("Valid after correction")));
    expect(valid.status).toBe(201);
    await expect(effectCounts()).resolves.toEqual({
      projects: 1,
      deliverables: 1,
      audits: 1,
      receipts: 1
    });
  });

  it("returns bounded INVALID_JSON without persisting a receipt or domain effect", async () => {
    const response = await createProjectRoute(
      new Request(`${origin}/api/projects`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "project-malformed-json-1"
        },
        body: "{"
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_JSON",
        message: "The request body is not valid JSON."
      }
    });
    await expect(effectCounts()).resolves.toEqual({
      projects: 0,
      deliverables: 0,
      audits: 0,
      receipts: 0
    });
  });

  it("rolls back receipt responses that exceed the serialized response bound", async () => {
    await expect(
      executeIdempotentResponse(
        {
          principalScope: "demo-bypass",
          method: "POST",
          requestPath: "/api/oversized-response-fixture",
          idempotencyKey: "oversized-response-fixture",
          requestHash: "a".repeat(64)
        },
        async () => ({
          responseStatus: 200,
          responseBody: JSON.stringify({ data: "x".repeat(4 * 1_024 * 1_024) })
        })
      )
    ).rejects.toMatchObject({
      status: 500,
      code: "IDEMPOTENCY_RESPONSE_TOO_LARGE"
    });
    expect(
      Number(
        (
          await query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM mutation_receipts"
          )
        ).rows[0].count
      )
    ).toBe(0);
  });
});
