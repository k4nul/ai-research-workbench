import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  BraveSearchProvider,
  OpenAIResponsesProvider,
  ProviderRequestError
} from "@/lib/providers";

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
});

async function contractServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  const server = createServer(handler);
  openServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Contract server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

const claimRequest = {
  stage: "claim_generation" as const,
  projectId: "contract-project",
  promptTemplateVersion: "claims-v2",
  allowedSourceIds: ["source-1"],
  input: {
    evidence: [{ sourceId: "source-1", summary: "Synthetic evidence." }],
    researchQuestion: "What does the fixture show?"
  }
};

function completedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp-contract-1",
    model: "gpt-5-mini-contract",
    status: "completed",
    output_text: JSON.stringify({
      claims: [
        {
          id: "claim-1",
          text: "Synthetic supported claim.",
          type: "FACT",
          importance: "HIGH",
          sourceIds: ["source-1"]
        }
      ]
    }),
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    ...overrides
  });
}

describe("OpenAI Responses deterministic HTTP contract", () => {
  it("sends strict schema, cancellation correlation, and records both request IDs", async () => {
    const base = await contractServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(request.url).toBe("/v1/responses");
        expect(request.headers["x-client-request-id"]).toBe("job-attempt-1");
        expect(body.store).toBe(false);
        expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "req-contract-1"
        });
        response.end(completedPayload());
      });
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/v1/responses`
    });

    const result = await provider.run(claimRequest, {
      clientRequestId: "job-attempt-1"
    });

    expect(result).toMatchObject({
      success: true,
      metadata: {
        requestId: "req-contract-1",
        providerResponseId: "resp-contract-1",
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
      }
    });
  });

  it.each([
    [429, "RATE_LIMITED", "RETRYABLE_PROVIDER_RATE_LIMIT", 2_000],
    [500, "SERVER_ERROR", "RETRYABLE_PROVIDER_SERVER_ERROR", undefined]
  ] as const)(
    "classifies HTTP %i without exposing the response body",
    async (status, code, classification, expectedRetryAfter) => {
      const base = await contractServer((_request, response) => {
        response.writeHead(status, {
          "content-type": "application/json",
          "retry-after": "2",
          "x-request-id": `req-${status}`
        });
        response.end(JSON.stringify({ error: { message: "secret provider detail" } }));
      });
      const provider = new OpenAIResponsesProvider({
        apiKey: "fixture-key",
        endpoint: `${base}/v1/responses`
      });

      const result = await provider.run(claimRequest);

      expect(result).toMatchObject({
        success: false,
        error: {
          code,
          classification,
          retryable: true,
          ...(expectedRetryAfter === undefined
            ? {}
            : { retryAfterMs: expectedRetryAfter })
        },
        metadata: { requestId: `req-${status}` }
      });
      expect(JSON.stringify(result)).not.toContain("secret provider detail");
    }
  );

  it("distinguishes cancellation from timeout", async () => {
    const base = await contractServer(() => undefined);
    const provider = new OpenAIResponsesProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/v1/responses`,
      timeoutMs: 1_000
    });
    const controller = new AbortController();
    const cancelled = provider.run(claimRequest, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      success: false,
      error: { code: "CANCELLED", classification: "CANCELLED", retryable: false }
    });

    await expect(provider.run(claimRequest)).resolves.toMatchObject({
      success: false,
      error: { code: "TIMEOUT", classification: "RETRYABLE_NETWORK", retryable: true }
    });
  });

  it.each([
    ["not-json", "completed", "INVALID_RESPONSE"],
    [JSON.stringify({ claims: "wrong" }), "completed", "INVALID_RESPONSE"],
    [JSON.stringify({ claims: [] }), "incomplete", "TRUNCATED"]
  ] as const)(
    "rejects invalid, schema-mismatched, and truncated structured output",
    async (outputText, status, errorCode) => {
      const base = await contractServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          completedPayload({
            status,
            output_text: outputText,
            ...(status === "incomplete"
              ? { incomplete_details: { reason: "max_output_tokens" } }
              : {})
          })
        );
      });
      const provider = new OpenAIResponsesProvider({
        apiKey: "fixture-key",
        endpoint: `${base}/v1/responses`
      });

      await expect(provider.run(claimRequest)).resolves.toMatchObject({
        success: false,
        error: { code: errorCode, retryable: false }
      });
    }
  );

  it("classifies a completed structured-output refusal without exposing its text", async () => {
    const base = await contractServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        completedPayload({
          output_text: undefined,
          output: [
            {
              type: "message",
              content: [
                { type: "refusal", refusal: "sensitive synthetic refusal detail" }
              ]
            }
          ]
        })
      );
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/v1/responses`
    });

    const result = await provider.run(claimRequest);

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "REFUSED",
        classification: "NON_RETRYABLE_VALIDATION",
        retryable: false
      }
    });
    expect(JSON.stringify(result)).not.toContain("sensitive synthetic refusal detail");
  });

  it.each([
    [
      "server_error",
      "SERVER_ERROR",
      "RETRYABLE_PROVIDER_SERVER_ERROR",
      undefined
    ],
    [
      "rate_limit_exceeded",
      "RATE_LIMITED",
      "RETRYABLE_PROVIDER_RATE_LIMIT",
      4_000
    ]
  ] as const)(
    "maps failed response error %s without exposing the provider message",
    async (providerCode, code, classification, expectedRetryAfter) => {
      const base = await contractServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "retry-after": "4"
        });
        response.end(
          completedPayload({
            status: "failed",
            output_text: undefined,
            error: {
              code: providerCode,
              message: "sensitive synthetic provider failure"
            }
          })
        );
      });
      const provider = new OpenAIResponsesProvider({
        apiKey: "fixture-key",
        endpoint: `${base}/v1/responses`
      });

      const result = await provider.run(claimRequest);

      expect(result).toMatchObject({
        success: false,
        error: {
          code,
          classification,
          retryable: true,
          ...(expectedRetryAfter === undefined
            ? {}
            : { retryAfterMs: expectedRetryAfter })
        }
      });
      expect(JSON.stringify(result)).not.toContain("sensitive synthetic provider failure");
    }
  );

  it("rejects a response that exceeds the configured byte limit", async () => {
    const base = await contractServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completedPayload({ output_text: "x".repeat(2_000) }));
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/v1/responses`,
      maxResponseBytes: 1_024
    });

    await expect(provider.run(claimRequest)).resolves.toMatchObject({
      success: false,
      error: {
        code: "RESPONSE_TOO_LARGE",
        classification: "NON_RETRYABLE_VALIDATION",
        retryable: false
      }
    });
  });

  it("accepts missing usage as unknown and exposes a stable duplicate response ID", async () => {
    const base = await contractServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completedPayload({ usage: undefined }));
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/v1/responses`
    });

    const first = await provider.run(claimRequest);
    const duplicate = await provider.run(claimRequest);

    expect(first.success).toBe(true);
    expect(first.metadata.usage).toBeUndefined();
    expect(duplicate.metadata.providerResponseId).toBe(first.metadata.providerResponseId);
  });
});

describe("Brave Search deterministic HTTP contract", () => {
  it("normalizes results and records rate limit metadata", async () => {
    const base = await contractServer((request, response) => {
      expect(request.headers["x-subscription-token"]).toBe("fixture-key");
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "brave-req-1",
        "x-ratelimit-limit": "1, 15000",
        "x-ratelimit-remaining": "0, 14999",
        "x-ratelimit-reset": "1, 100"
      });
      response.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: "<b>Synthetic result</b>",
                url: "https://example.com/evidence",
                description: "<em>Fixture only</em>"
              }
            ]
          }
        })
      );
    });
    const provider = new BraveSearchProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/res/v1/web/search`
    });

    const result = await provider.search({ query: "synthetic evidence" });

    expect(result.results[0]).toMatchObject({
      title: "Synthetic result",
      url: "https://example.com/evidence",
      snippet: "Fixture only"
    });
    expect(result.metadata).toMatchObject({
      requestId: "brave-req-1",
      rateLimit: { remaining: "0, 14999", reset: "1, 100" }
    });
  });

  it("classifies 429 using Brave reset headers and rejects invalid JSON", async () => {
    let requestCount = 0;
    const base = await contractServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "x-ratelimit-limit": "1, 15000",
          "x-ratelimit-remaining": "1, 0",
          "x-ratelimit-reset": "3, 100"
        });
        response.end("{}");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not-json");
      }
    });
    const provider = new BraveSearchProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/res/v1/web/search`
    });

    await expect(provider.search({ query: "fixture" })).rejects.toMatchObject({
      name: "ProviderRequestError",
      classification: "RETRYABLE_PROVIDER_RATE_LIMIT",
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 100_000
    } satisfies Partial<ProviderRequestError>);
    await expect(provider.search({ query: "fixture" })).rejects.toMatchObject({
      name: "ProviderRequestError",
      classification: "NON_RETRYABLE_VALIDATION",
      retryable: false
    });
  });

  it("prefers generic Retry-After over Brave reset headers", async () => {
    const base = await contractServer((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
        "x-ratelimit-limit": "1, 0",
        "x-ratelimit-remaining": "0, 0",
        "x-ratelimit-reset": "3, 100"
      });
      response.end("{}");
    });
    const provider = new BraveSearchProvider({
      apiKey: "fixture-key",
      endpoint: `${base}/res/v1/web/search`
    });

    await expect(provider.search({ query: "fixture" })).rejects.toMatchObject({
      classification: "RETRYABLE_PROVIDER_RATE_LIMIT",
      retryAfterMs: 2_000
    } satisfies Partial<ProviderRequestError>);
  });
});
