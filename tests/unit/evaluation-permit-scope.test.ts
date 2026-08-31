import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  researchProviderPermitOperation,
  syntheticEvaluationProviderConfig
} from "@/worker/research-pipeline-handler";

describe("synthetic evaluation provider permit scope", () => {
  it("isolates only a strictly marked internal mock evaluation run", () => {
    const runId = randomUUID();
    const scopeId = randomUUID();

    expect(
      researchProviderPermitOperation("mock-ai", {
        id: runId,
        provider_config_snapshot: syntheticEvaluationProviderConfig(scopeId)
      })
    ).toBe(`ai.run.synthetic-evaluation:${scopeId}:${runId}`);
  });

  it("keeps ordinary mock and live provider calls in the shared window", () => {
    const runId = randomUUID();
    const marked = syntheticEvaluationProviderConfig(randomUUID());

    expect(
      researchProviderPermitOperation("mock-ai", {
        id: runId,
        provider_config_snapshot: { aiProvider: "mock-ai" }
      })
    ).toBe("ai.run");
    expect(
      researchProviderPermitOperation("openai-responses", {
        id: runId,
        provider_config_snapshot: marked
      })
    ).toBe("ai.run");
    expect(
      researchProviderPermitOperation("mock-ai", {
        id: runId,
        provider_config_snapshot: {
          ...marked,
          internalExecutionProfile: {
            ...marked.internalExecutionProfile,
            userControlled: true
          }
        }
      })
    ).toBe("ai.run");
  });

  it("rejects malformed internal scope identifiers", () => {
    expect(() => syntheticEvaluationProviderConfig("evaluation-1")).toThrow(
      "Synthetic evaluation permit scope must be a UUIDv4."
    );
  });
});
