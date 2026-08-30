import { describe, expect, it, vi } from "vitest";
import {
  AI_STAGES,
  aiStageOutputSchemas,
  aiStageInputSchemas,
  BraveSearchProvider,
  MockAIProvider,
  MockSearchProvider,
  OpenAIResponsesProvider,
  selectProviders,
  type AIStage,
  type AIStageRequest,
  type AnyAIStageRequest
} from "@/lib/providers";
import { parseStageOutput } from "@/lib/providers/ai-shared";

const now = () => new Date("2026-08-30T00:00:00.000Z");

const stageRequests = {
  intake_analysis: {
    stage: "intake_analysis",
    projectId: "project-1",
    promptTemplateVersion: "intake-v1",
    allowedSourceIds: [],
    input: { brief: "Assess a sample software purchase.", asOfDate: "2026-08-30" }
  },
  question_decomposition: {
    stage: "question_decomposition",
    projectId: "project-1",
    promptTemplateVersion: "questions-v1",
    allowedSourceIds: [],
    input: {
      coreQuestion: "Should the sample product be adopted?",
      scope: "Synthetic demo only",
      completionCriteria: ["Compare cost and risk."]
    }
  },
  research_plan: {
    stage: "research_plan",
    projectId: "project-1",
    promptTemplateVersion: "plan-v1",
    allowedSourceIds: [],
    input: {
      questions: [{ id: "question-1", question: "What is the sample cost?" }],
      constraints: ["Use public sources."]
    }
  },
  source_summary: {
    stage: "source_summary",
    projectId: "project-1",
    promptTemplateVersion: "summary-v1",
    allowedSourceIds: ["source-1"],
    input: { sourceId: "source-1", content: "Synthetic source evidence." }
  },
  evidence_extraction: {
    stage: "evidence_extraction",
    projectId: "project-1",
    promptTemplateVersion: "evidence-v1",
    allowedSourceIds: ["source-1"],
    input: { sources: [{ sourceId: "source-1", content: "Synthetic source evidence." }] }
  },
  claim_generation: {
    stage: "claim_generation",
    projectId: "project-1",
    promptTemplateVersion: "claims-v1",
    allowedSourceIds: ["source-1"],
    input: {
      evidence: [{ sourceId: "source-1", summary: "Synthetic evidence." }],
      researchQuestion: "What does the sample show?"
    }
  },
  gap_detection: {
    stage: "gap_detection",
    projectId: "project-1",
    promptTemplateVersion: "gaps-v1",
    allowedSourceIds: ["source-1"],
    input: {
      questions: [{ id: "question-1", question: "What remains unknown?" }],
      claims: [
        { questionId: "question-1", text: "A supported claim", sourceIds: ["source-1"] }
      ]
    }
  },
  conflict_detection: {
    stage: "conflict_detection",
    projectId: "project-1",
    promptTemplateVersion: "conflicts-v1",
    allowedSourceIds: ["source-1"],
    input: {
      claims: [{ text: "A supported claim", sourceIds: ["source-1"] }],
      evidence: [{ sourceId: "source-1", summary: "Synthetic evidence." }]
    }
  },
  report_outline: {
    stage: "report_outline",
    projectId: "project-1",
    promptTemplateVersion: "outline-v1",
    allowedSourceIds: ["source-1"],
    input: {
      findings: [
        { id: "finding-1", summary: "Synthetic finding.", sourceIds: ["source-1"] }
      ],
      claimIds: ["claim-1"]
    }
  },
  draft_generation: {
    stage: "draft_generation",
    projectId: "project-1",
    promptTemplateVersion: "draft-v1",
    allowedSourceIds: ["source-1"],
    input: {
      title: "Sample report",
      outline: [{ title: "Summary", purpose: "Summarize evidence." }],
      claims: [{ id: "claim-1", text: "Synthetic claim.", sourceIds: ["source-1"] }]
    }
  },
  qa_revision: {
    stage: "qa_revision",
    projectId: "project-1",
    promptTemplateVersion: "qa-v1",
    allowedSourceIds: [],
    input: {
      draft: "Synthetic draft.",
      qaFindings: [{ severity: "HIGH", location: "Summary", problem: "Missing caveat." }]
    }
  }
} satisfies { [Stage in AIStage]: AIStageRequest<Stage> };

describe("deterministic mock providers", () => {
  it("rejects malformed or empty stage input before provider execution", () => {
    expect(
      aiStageInputSchemas.research_plan.safeParse({ questions: [], constraints: [] }).success
    ).toBe(false);
    expect(
      aiStageInputSchemas.source_summary.safeParse({ sourceId: "source-1" }).success
    ).toBe(false);
  });

  it("rejects duplicate source IDs in structured AI output", () => {
    const parsed = aiStageOutputSchemas.draft_generation.safeParse({
      title: "Duplicate citation fixture",
      markdown: "Fixture [@source-1].",
      citationSourceIds: ["source-1", "source-1"],
      limitations: []
    });

    expect(parsed.success).toBe(false);
  });

  it("matches generated question and plan bounds to persistence", () => {
    const question = {
      id: "question-1",
      question: "Valid question?",
      priority: "HIGH" as const,
      completionCriteria: ["Done"]
    };
    expect(
      aiStageOutputSchemas.question_decomposition.safeParse({ questions: [question] }).success
    ).toBe(true);
    expect(
      aiStageOutputSchemas.question_decomposition.safeParse({
        questions: [{ ...question, question: "Four" }]
      }).success
    ).toBe(false);
    expect(
      aiStageOutputSchemas.question_decomposition.safeParse({
        questions: [{ ...question, completionCriteria: ["No"] }]
      }).success
    ).toBe(false);
    expect(
      aiStageOutputSchemas.question_decomposition.safeParse({
        questions: [{ ...question, completionCriteria: [] }]
      }).success
    ).toBe(false);
    expect(
      aiStageOutputSchemas.question_decomposition.safeParse({
        questions: [{ ...question, question: "x".repeat(4_001) }]
      }).success
    ).toBe(false);

    const plan = {
      id: "plan-1",
      questionId: "question-1",
      searchStrategy: "Review fixtures.",
      queries: [],
      primarySourceTypes: [],
      secondarySourceTypes: [],
      comparisonTargets: [],
      expectedOutput: "A cited answer.",
      completionCondition: "One fixture is reviewed.",
      risks: [],
      researchGap: null
    };
    expect(aiStageOutputSchemas.research_plan.safeParse({ steps: [plan] }).success).toBe(true);
    for (const field of [
      "searchStrategy",
      "expectedOutput",
      "completionCondition"
    ] as const) {
      expect(
        aiStageOutputSchemas.research_plan.safeParse({
          steps: [{ ...plan, [field]: "No" }]
        }).success
      ).toBe(false);
    }
    expect(
      aiStageOutputSchemas.research_plan.safeParse({
        steps: [{ ...plan, queries: Array.from({ length: 31 }, () => "fixture") }]
      }).success
    ).toBe(false);
    expect(
      aiStageOutputSchemas.research_plan.safeParse({
        steps: [{ ...plan, searchStrategy: "x".repeat(10_001) }]
      }).success
    ).toBe(false);
  });

  it("rejects draft citation metadata that differs from inline citations", () => {
    expect(() =>
      parseStageOutput("draft_generation", {
        title: "Citation mismatch fixture",
        markdown: "Fixture [source-1].",
        citationSourceIds: [],
        limitations: []
      })
    ).toThrow("Draft citations must exactly match citationSourceIds");
  });

  it("runs every required AI pipeline stage without an API key", async () => {
    const provider = new MockAIProvider(now);
    expect(provider.isConfigured()).toBe(true);
    expect(Object.keys(stageRequests).sort()).toEqual([...AI_STAGES].sort());

    for (const request of Object.values(stageRequests) as AnyAIStageRequest[]) {
      const first = await provider.run(request as AIStageRequest<AIStage>);
      const second = await provider.run(request as AIStageRequest<AIStage>);
      expect(first.success, request.stage).toBe(true);
      expect(second, request.stage).toEqual(first);
      expect(first.metadata.provider).toBe("mock-ai");
      expect(first.metadata.promptTemplateVersion).toBe(request.promptTemplateVersion);
      expect(first.metadata.inputHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects source IDs outside the explicit allowlist", async () => {
    const provider = new MockAIProvider(now);
    const result = await provider.run({
      ...stageRequests.source_summary,
      allowedSourceIds: ["source-1"],
      input: { sourceId: "invented-source", content: "Not allowed." }
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "UNKNOWN_SOURCE_ID" }
    });
  });

  it("returns stable fixture search results without an API key", async () => {
    const provider = new MockSearchProvider(undefined, now);
    const first = await provider.search({ query: "official guidance", count: 2 });
    const second = await provider.search({ query: "official guidance", count: 2 });
    expect(first).toEqual(second);
    expect(first.results[0].id).toBe("mock-official-guidance");
  });
});

describe("Brave Search provider", () => {
  it("uses the official endpoint/header and normalizes web results", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "<b>Official result</b>",
                url: "https://example.com/report#section",
                description: "<em>Verified snippet</em>",
                page_age: "2026-08-01",
                language: "en"
              },
              {
                title: "Blocked result",
                url: "http://127.0.0.1/admin",
                description: "Must be ignored"
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "brave-request-1"
          }
        }
      );
    });
    const provider = new BraveSearchProvider({
      apiKey: "brave-secret-key",
      fetch: fetchMock,
      now
    });

    const result = await provider.search({
      query: "official evidence",
      count: 5,
      country: "kr",
      searchLanguage: "ko",
      uiLanguage: "ko-kr",
      freshness: "pm"
    });

    const url = new URL(capturedUrl);
    expect(url.origin + url.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search"
    );
    expect(url.searchParams.get("q")).toBe("official evidence");
    expect(url.searchParams.get("country")).toBe("KR");
    expect(url.searchParams.get("text_decorations")).toBe("false");
    expect(capturedHeaders.get("X-Subscription-Token")).toBe("brave-secret-key");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      title: "Official result",
      url: "https://example.com/report",
      snippet: "Verified snippet",
      publishedAt: "2026-08-01"
    });
    expect(result.metadata.requestId).toBe("brave-request-1");
  });
});

describe("OpenAI Responses provider", () => {
  it("sends strict structured output and records usage metadata", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const output = {
      claims: [
        {
          id: "claim-1",
          text: "Synthetic supported claim.",
          type: "FACT",
          importance: "HIGH",
          sourceIds: ["source-1"]
        }
      ]
    };
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp-1",
          model: "gpt-5-mini-2026-08-01",
          status: "completed",
          output_text: JSON.stringify(output),
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: "openai-secret-key",
      model: "gpt-5-mini",
      fetch: fetchMock,
      now
    });

    const result = await provider.run(stageRequests.claim_generation);

    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer openai-secret-key");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      name: "research_claim_generation",
      strict: true
    });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.instructions).toContain("untrusted data");
    expect(JSON.parse(body.input).allowedSourceIds).toEqual(["source-1"]);
    expect(result).toMatchObject({
      success: true,
      output,
      metadata: {
        provider: "openai-responses",
        model: "gpt-5-mini-2026-08-01",
        requestId: "resp-1",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
      }
    });
  });

  it("rejects a structurally valid response containing an invented source ID", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "resp-2",
          model: "gpt-5-mini",
          status: "completed",
          output_text: JSON.stringify({
            claims: [
              {
                id: "claim-1",
                text: "Invented citation.",
                type: "FACT",
                importance: "HIGH",
                sourceIds: ["invented-source"]
              }
            ]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: "openai-secret-key",
      fetch: fetchMock,
      now
    });

    const result = await provider.run(stageRequests.claim_generation);

    expect(result).toMatchObject({
      success: false,
      error: { code: "UNKNOWN_SOURCE_ID" }
    });
  });

  it("rejects invented source IDs embedded in draft citation syntax", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "resp-3",
          model: "gpt-5-mini",
          status: "completed",
          output_text: JSON.stringify({
            title: "Sample report",
            markdown: "Unsupported citation [invented-source].",
            citationSourceIds: ["invented-source"],
            limitations: []
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: "openai-secret-key",
      fetch: fetchMock,
      now
    });

    const result = await provider.run(stageRequests.draft_generation);

    expect(result).toMatchObject({
      success: false,
      error: { code: "UNKNOWN_SOURCE_ID" }
    });
  });

  it("does not call the network when no API key is configured", async () => {
    const fetchMock: typeof fetch = vi.fn();
    const provider = new OpenAIResponsesProvider({ fetch: fetchMock, now });
    const result = await provider.run(stageRequests.intake_analysis);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: { code: "NOT_CONFIGURED" }
    });
  });
});

describe("provider selection and status", () => {
  it("selects no-key mocks by default and never exposes raw credentials", () => {
    const selection = selectProviders({
      demoMode: true,
      openAiApiKey: "sk-secret-openai-value",
      openAiModel: "gpt-5-mini",
      braveSearchApiKey: "brave-secret-value"
    });
    expect(selection.ai.id).toBe("mock-ai");
    expect(selection.search.id).toBe("mock-search");
    const serialized = JSON.stringify(selection.statuses);
    expect(serialized).not.toContain("sk-secret-openai-value");
    expect(serialized).not.toContain("brave-secret-value");
    expect(selection.statuses.find((item) => item.provider === "openai-responses")).toMatchObject({
      active: false,
      configured: true,
      credential: "sk-••••lue"
    });
  });

  it("activates live adapters only outside demo mode when keys exist", () => {
    const live = selectProviders({
      demoMode: false,
      openAiApiKey: "openai-key-value",
      openAiModel: "gpt-5-mini",
      braveSearchApiKey: "brave-key-value"
    });
    expect(live.ai.id).toBe("openai-responses");
    expect(live.search.id).toBe("brave-search");

    const fallback = selectProviders({
      demoMode: false,
      openAiModel: "gpt-5-mini"
    });
    expect(fallback.ai.id).toBe("mock-ai");
    expect(fallback.search.id).toBe("mock-search");
  });
});
