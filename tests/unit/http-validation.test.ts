import { describe, expect, it } from "vitest";
import { handleRoute } from "@/lib/http";
import { AppError } from "@/lib/services/errors";
import { projectIntakeSchema } from "@/lib/validation";
import { POST as searchSources } from "@/app/api/projects/[projectId]/sources/search/route";

describe("HTTP and intake boundaries", () => {
  it("marks successful and failed JSON API responses as non-cacheable", async () => {
    const success = await handleRoute(async () => ({ ok: true }));
    const failure = await handleRoute(async () => {
      throw new SyntaxError("fixture");
    });

    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(failure.headers.get("cache-control")).toBe("no-store");
    expect(failure.status).toBe(400);
  });

  it("normalizes rate-limit errors as stable non-cacheable JSON", async () => {
    const response = await handleRoute(async () => {
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests. Wait before retrying.",
        { retryAfterSeconds: 60 }
      );
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Wait before retrying.",
        details: { retryAfterSeconds: 60 }
      }
    });
  });

  it("normalizes rate limiting thrown by an actual route handler", async () => {
    const client = `rate-limit-route-${crypto.randomUUID()}`;
    const context = { params: Promise.resolve({ projectId: "project-fixture" }) };
    const request = () =>
      new Request("http://localhost/api/projects/project-fixture/sources/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "rate-limit-route-fixture",
          "x-forwarded-for": client
        },
        body: "{"
      });

    for (let index = 0; index < 10; index += 1) {
      const warmup = await searchSources(request(), context);
      expect(warmup.status).toBe(400);
      if (index === 0) {
        await expect(warmup.json()).resolves.toMatchObject({
          error: { code: "INVALID_JSON" }
        });
      }
    }

    const response = await searchSources(request(), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Wait before retrying.",
        details: { retryAfterSeconds: expect.any(Number) }
      }
    });
  });

  it("rejects an oversized streamed mutation without waiting on the cloned body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1_024 * 1_024 + 1));
        controller.close();
      }
    });
    const request = new Request(
      "http://localhost/api/projects/project-fixture/sources/search",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "oversized-stream-fixture",
          "x-forwarded-for": `oversized-stream-${crypto.randomUUID()}`
        },
        body,
        duplex: "half"
      } as RequestInit & { duplex: "half" }
    );
    expect(request.headers.has("content-length")).toBe(false);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        searchSources(request, {
          params: Promise.resolve({ projectId: "project-fixture" })
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Oversized streamed mutation did not return promptly.")),
            1_000
          );
        })
      ]);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "MUTATION_BODY_TOO_LARGE" }
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  it("rejects duplicate deliverable formats", () => {
    const result = projectIntakeSchema.safeParse({
      name: "Validation fixture",
      coreQuestion: "Which fixture validates the intake boundary?",
      purpose: "Test validation.",
      audience: "Test reviewer",
      scope: "Synthetic fixture only.",
      researchDate: "2026-08-30",
      deliverableFormats: ["PDF", "PDF"]
    });

    expect(result.success).toBe(false);
  });
});
