import { AI_STAGES, type AIStage } from "@/lib/providers";

export const RESEARCH_PIPELINE_VERSION = "research-pipeline.v2";

export type PipelineStageDefinition = {
  id: AIStage;
  ordinal: number;
  dependencies: readonly AIStage[];
  promptTemplateVersion: string;
  structuredSchemaVersion: string;
  timeoutMs: number;
  maxAttempts: number;
};

const definitions: Readonly<Record<AIStage, PipelineStageDefinition>> = {
  intake_analysis: {
    id: "intake_analysis",
    ordinal: 1,
    dependencies: [],
    promptTemplateVersion: "intake-analysis.v2",
    structuredSchemaVersion: "intake-analysis.schema.v1",
    timeoutMs: 60_000,
    maxAttempts: 3
  },
  question_decomposition: {
    id: "question_decomposition",
    ordinal: 2,
    dependencies: ["intake_analysis"],
    promptTemplateVersion: "question-decomposition.v2",
    structuredSchemaVersion: "question-decomposition.schema.v1",
    timeoutMs: 60_000,
    maxAttempts: 3
  },
  research_plan: {
    id: "research_plan",
    ordinal: 3,
    dependencies: ["question_decomposition"],
    promptTemplateVersion: "research-plan.v2",
    structuredSchemaVersion: "research-plan.schema.v1",
    timeoutMs: 90_000,
    maxAttempts: 3
  },
  source_summary: {
    id: "source_summary",
    ordinal: 4,
    dependencies: ["research_plan"],
    promptTemplateVersion: "source-summary.v2",
    structuredSchemaVersion: "source-summary.schema.v1",
    timeoutMs: 90_000,
    maxAttempts: 3
  },
  evidence_extraction: {
    id: "evidence_extraction",
    ordinal: 5,
    dependencies: ["source_summary"],
    promptTemplateVersion: "evidence-extraction.v2",
    structuredSchemaVersion: "evidence-extraction.schema.v1",
    timeoutMs: 120_000,
    maxAttempts: 3
  },
  claim_generation: {
    id: "claim_generation",
    ordinal: 6,
    dependencies: ["evidence_extraction"],
    promptTemplateVersion: "claim-generation.v2",
    structuredSchemaVersion: "claim-generation.schema.v1",
    timeoutMs: 90_000,
    maxAttempts: 3
  },
  gap_detection: {
    id: "gap_detection",
    ordinal: 7,
    dependencies: ["claim_generation"],
    promptTemplateVersion: "gap-detection.v2",
    structuredSchemaVersion: "gap-detection.schema.v1",
    timeoutMs: 60_000,
    maxAttempts: 2
  },
  conflict_detection: {
    id: "conflict_detection",
    ordinal: 8,
    dependencies: ["gap_detection"],
    promptTemplateVersion: "conflict-detection.v2",
    structuredSchemaVersion: "conflict-detection.schema.v1",
    timeoutMs: 60_000,
    maxAttempts: 2
  },
  report_outline: {
    id: "report_outline",
    ordinal: 9,
    dependencies: ["conflict_detection"],
    promptTemplateVersion: "report-outline.v2",
    structuredSchemaVersion: "report-outline.schema.v1",
    timeoutMs: 60_000,
    maxAttempts: 3
  },
  draft_generation: {
    id: "draft_generation",
    ordinal: 10,
    dependencies: ["report_outline"],
    promptTemplateVersion: "draft-generation.v2",
    structuredSchemaVersion: "draft-generation.schema.v1",
    timeoutMs: 120_000,
    maxAttempts: 3
  },
  qa_revision: {
    id: "qa_revision",
    ordinal: 11,
    dependencies: ["draft_generation"],
    promptTemplateVersion: "qa-revision.v2",
    structuredSchemaVersion: "qa-revision.schema.v1",
    timeoutMs: 90_000,
    maxAttempts: 2
  }
};

export const PIPELINE_STAGE_CATALOG: readonly PipelineStageDefinition[] = AI_STAGES.map(
  (stage) => definitions[stage]
);

export function getPipelineStageDefinition(stage: AIStage): PipelineStageDefinition {
  return definitions[stage];
}

export function validatePipelineStageCatalog(
  catalog: readonly PipelineStageDefinition[] = PIPELINE_STAGE_CATALOG
): void {
  if (catalog.length !== AI_STAGES.length) {
    throw new Error("Pipeline catalog must define every AI stage exactly once.");
  }
  const ids = new Set(catalog.map((stage) => stage.id));
  const ordinals = new Set(catalog.map((stage) => stage.ordinal));
  if (ids.size !== AI_STAGES.length || ordinals.size !== AI_STAGES.length) {
    throw new Error("Pipeline stage IDs and ordinals must be unique.");
  }
  for (const stage of catalog) {
    if (!AI_STAGES.includes(stage.id)) {
      throw new Error(`Unknown pipeline stage ${stage.id}.`);
    }
    if (stage.ordinal < 1 || stage.ordinal > AI_STAGES.length) {
      throw new Error(`Pipeline stage ${stage.id} has an invalid ordinal.`);
    }
    for (const dependency of stage.dependencies) {
      const dependencyDefinition = catalog.find((item) => item.id === dependency);
      if (!dependencyDefinition || dependencyDefinition.ordinal >= stage.ordinal) {
        throw new Error(`Pipeline stage ${stage.id} has an invalid dependency.`);
      }
    }
  }
}

validatePipelineStageCatalog();
