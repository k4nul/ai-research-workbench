import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "@/lib/db";
import {
  acquireProviderPermit,
  extendProviderPermit,
  releaseProviderPermit
} from "@/lib/services/provider-limits";
import {
  finishProviderExecution,
  startProviderExecution
} from "@/lib/services/provider-executions";
import {
  getWorkerReadiness,
  heartbeatWorker,
  listWorkers,
  registerWorker,
  stopWorker
} from "@/lib/services/workers";
import { getOperationalMetrics } from "@/lib/services/operational-metrics";
import { GET as getWebHealth } from "@/app/api/health/route";
import { resetTestDatabase } from "@/tests/helpers/database";

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closePool();
});

describe("shared provider limits", () => {
  it("shares concurrency and request-window limits across owners", async () => {
    const policy = {
      requestLimit: 2,
      windowSeconds: 60,
      concurrencyLimit: 1,
      permitTtlMs: 5_000
    };
    const first = await acquireProviderPermit({
      provider: "fixture-provider",
      operation: "responses",
      ownerId: "worker-a",
      policy
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("Expected the first permit to be acquired.");

    await expect(
      acquireProviderPermit({
        provider: "fixture-provider",
        operation: "responses",
        ownerId: "worker-b",
        policy
      })
    ).resolves.toMatchObject({ allowed: false, reason: "CONCURRENCY" });
    await expect(
      extendProviderPermit({ permitId: first.permitId, ownerId: "worker-b", ttlMs: 5_000 })
    ).resolves.toBe(false);
    await expect(
      extendProviderPermit({ permitId: first.permitId, ownerId: "worker-a", ttlMs: 5_000 })
    ).resolves.toBe(true);
    await expect(
      releaseProviderPermit({ permitId: first.permitId, ownerId: "worker-a" })
    ).resolves.toBe(true);

    const second = await acquireProviderPermit({
      provider: "fixture-provider",
      operation: "responses",
      ownerId: "worker-b",
      policy
    });
    expect(second.allowed).toBe(true);
    if (!second.allowed) throw new Error("Expected the second permit to be acquired.");
    await releaseProviderPermit({ permitId: second.permitId, ownerId: "worker-b" });

    await expect(
      acquireProviderPermit({
        provider: "fixture-provider",
        operation: "responses",
        ownerId: "worker-c",
        policy
      })
    ).resolves.toMatchObject({ allowed: false, reason: "REQUEST_WINDOW" });
  });
});

describe("provider execution provenance", () => {
  it("records terminal usage and rejects duplicate provider response IDs", async () => {
    const first = await startProviderExecution({
      provider: "fixture-provider",
      model: "fixture-model",
      operation: "responses",
      clientRequestId: "client-request-a",
      promptTemplateVersion: "fixture.prompt.v1",
      structuredSchemaVersion: "fixture.schema.v1",
      inputHash: "a".repeat(64),
      retryCount: 0
    });
    await expect(
      finishProviderExecution({
        id: first,
        status: "SUCCEEDED",
        requestId: "request-a",
        providerResponseId: "response-shared",
        outputHash: "b".repeat(64),
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costStatus: "KNOWN",
        estimatedCostUsd: 0.001
      })
    ).resolves.toEqual({});

    const duplicate = await startProviderExecution({
      provider: "fixture-provider",
      model: "fixture-model",
      operation: "responses",
      clientRequestId: "client-request-b",
      inputHash: "c".repeat(64),
      retryCount: 1
    });
    await expect(
      finishProviderExecution({
        id: duplicate,
        status: "FAILED",
        providerResponseId: "response-shared",
        costStatus: "UNKNOWN",
        estimatedCostUsd: null,
        sanitizedError: "Bearer secret-token password=hunter2"
      })
    ).resolves.toEqual({ duplicateOf: first });
    const persisted = await query<{ status: string; sanitized_error: string }>(
      "SELECT status, sanitized_error FROM provider_executions WHERE id = $1",
      [duplicate]
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "REJECTED",
      sanitized_error: "Duplicate provider response ID"
    });
  });
});

describe("worker readiness and operational metrics", () => {
  it("keeps worker readiness separate from web health and aggregates safe metrics", async () => {
    await registerWorker({
      workerId: "worker-ready",
      serviceVersion: "0.2.0",
      concurrency: 2,
      providerConcurrency: 1,
      extractionConcurrency: 1,
      metadata: { runtime: "integration-test" }
    });
    await expect(
      heartbeatWorker({ workerId: "worker-ready", status: "READY", activeJobs: 1 })
    ).resolves.toBe(true);
    await expect(
      getWorkerReadiness({ workerId: "worker-ready", staleAfterSeconds: 30 })
    ).resolves.toMatchObject({
      ready: true,
      checks: { database: true, heartbeat: true, status: true }
    });
    const workers = await listWorkers(30);
    expect(workers).toHaveLength(1);
    expect(workers[0]).not.toHaveProperty("databaseUrl");

    const unknownCostExecution = await startProviderExecution({
      provider: "unpriced-provider",
      model: "unpriced-model",
      operation: "responses",
      clientRequestId: "unknown-cost-metrics",
      inputHash: "d".repeat(64),
      retryCount: 0
    });
    await finishProviderExecution({
      id: unknownCostExecution,
      status: "SUCCEEDED",
      costStatus: "UNKNOWN",
      estimatedCostUsd: null
    });

    const metrics = await getOperationalMetrics(30);
    expect(metrics.workers).toEqual({ active: 1, stale: 0 });
    expect(metrics.providers.failureRate).toBeGreaterThanOrEqual(0);
    expect(metrics.providers).toMatchObject({
      costStatus: "UNKNOWN",
      estimatedCostUsd: null
    });
    expect(metrics.stages).toEqual({
      succeeded: 0,
      failed: 0,
      blocked: 0,
      averageDurationMs: null
    });
    expect(metrics.exports).toEqual({ count: 0, averageDurationMs: null });
    expect(metrics).not.toHaveProperty("secrets");

    const webHealth = await getWebHealth();
    expect(webHealth.status).toBe(200);
    await expect(webHealth.json()).resolves.toMatchObject({
      status: "ok",
      database: "connected",
      objectStorage: "connected",
      storageProvider: "LOCAL",
      auth: "bypassed-local",
      mode: "demo"
    });

    await expect(stopWorker({ workerId: "worker-ready" })).resolves.toBe(true);
    await expect(
      getWorkerReadiness({ workerId: "worker-ready", staleAfterSeconds: 30 })
    ).resolves.toMatchObject({ ready: false });
  });
});
