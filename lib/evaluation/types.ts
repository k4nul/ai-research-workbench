export type EvalFixtureId =
  | "supported"
  | "conflict"
  | "stale"
  | "numeric-units"
  | "irrelevant"
  | "prompt-injection"
  | "insufficient"
  | "partial-answer"
  | "duplicate-source"
  | "closed-corpus";

export type EvalImportance = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface EvalQuestionInput {
  key: string;
  question: string;
  priority?: EvalImportance;
}

export interface EvalSourceInput {
  key: string;
  title: string;
  content: string;
  publishedAt?: string;
  publisher?: string;
}

export interface EvalQaBlockerInput {
  key: string;
  ruleCode: string;
  problem: string;
}

/**
 * Synthetic material supplied to the product. This deliberately contains no
 * expected detections or precomputed provider output.
 */
export interface EvalFixtureInput {
  id: EvalFixtureId;
  description: string;
  synthetic: true;
  coreQuestion: string;
  researchDate: string;
  sourceMaxAgeDays: number;
  questions: readonly EvalQuestionInput[];
  sources: readonly EvalSourceInput[];
  externalProjectSources?: readonly EvalSourceInput[];
  qaBlockers?: readonly EvalQaBlockerInput[];
}

export interface EvalExpectedConflict {
  sourceKeys: readonly string[];
}

/** Gold labels are reviewed independently from the synthetic product input. */
export interface EvalGoldLabels {
  fixtureId: EvalFixtureId;
  reportableSourceKeys: readonly string[];
  staleSourceKeys: readonly string[];
  conflicts: readonly EvalExpectedConflict[];
  gapQuestionKeys: readonly string[];
  qaBlockerKeys: readonly string[];
  promptInjectionSourceKeys: readonly string[];
  requiredReportSections: readonly string[];
  expectedRunStatus: "APPROVAL_REQUIRED" | "BLOCKED";
  numericConsistencyConflict?: EvalExpectedConflict;
  unitConsistencyConflict?: EvalExpectedConflict;
}

export interface EvalObservedSource {
  id: string;
  key: string | null;
  projectId: string;
  freshnessStatus: string;
  promptInjectionFlag: boolean;
  duplicateOfSourceKey: string | null;
}

export interface EvalObservedEvidence {
  id: string;
  sourceId: string;
  sourceKey: string | null;
  sourceProjectId: string | null;
  summary: string;
  verificationStatus: string;
}

export interface EvalObservedEvidenceLink {
  evidenceId: string;
  evidenceExists: boolean;
  relationship: string;
  sourceId: string | null;
  sourceKey: string | null;
  sourceProjectId: string | null;
}

export interface EvalObservedClaim {
  id: string;
  questionKey: string | null;
  content: string;
  importance: EvalImportance;
  withinScope: boolean;
  evidenceLinks: readonly EvalObservedEvidenceLink[];
}

export interface EvalObservedFinding {
  id: string;
  withinScope: boolean;
}

export interface EvalObservedGap {
  questionKey: string | null;
  severity: string;
  description: string;
}

export interface EvalObservedConflict {
  sourceKeys: readonly (string | null)[];
  sourceProjectIds: readonly (string | null)[];
  description: string;
  resolutionNeeded: boolean;
}

export interface EvalObservedQaFinding {
  ruleCode: string;
  severity: EvalImportance | "BLOCKER";
  location: string;
  problem: string;
  resolutionStatus: string;
  evalKey: string | null;
  sourceKeys: readonly (string | null)[];
}

export interface EvalObservedCitation {
  sourceId: string;
  sourceKey: string | null;
  sourceProjectId: string | null;
}

export interface EvalRunObservation {
  fixtureId: EvalFixtureId;
  projectId: string;
  runId: string;
  runStatus: string;
  provider: string;
  model: string;
  pipelineVersion: string;
  promptVersion: string;
  succeededStageIds: readonly string[];
  normalizedStageOutputs: Readonly<Record<string, unknown>>;
  sources: readonly EvalObservedSource[];
  evidence: readonly EvalObservedEvidence[];
  claims: readonly EvalObservedClaim[];
  findings: readonly EvalObservedFinding[];
  gaps: readonly EvalObservedGap[];
  conflicts: readonly EvalObservedConflict[];
  qaFindings: readonly EvalObservedQaFinding[];
  reportSections: Readonly<Record<string, string>>;
  citations: readonly EvalObservedCitation[];
  providerRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
}

export interface EvalFixtureExecution {
  fixtureId: EvalFixtureId;
  primary: EvalRunObservation;
  repeat: EvalRunObservation;
}

export interface EvalFixtureMetrics {
  fixtureId: EvalFixtureId;
  primaryRunId: string;
  repeatRunId: string;
  citationIntegrity: number;
  citationPrecision: number;
  supportedClaimRate: number;
  unsupportedCriticalClaimCount: number;
  evidenceCoverage: number;
  sourceDiversity: number;
  staleSourceDetection: number;
  conflictDetection: number;
  researchGapDetection: number;
  numericConsistency: number;
  unitConsistency: number;
  outOfScopeFindingCount: number;
  qaBlockerRecall: number;
  qaBlockerBypassCount: number;
  reportRequiredSectionCompletion: number;
  crossProjectEvidenceReferenceCount: number;
  promptInjectionPolicyBypassCount: number;
  pipelineStageCompletion: number;
  providerRequestCompleteness: number;
  boundaryCompliance: number;
  providerRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  outputHash: string;
  repeatOutputHash: string;
  reproducible: boolean;
}

export interface EvalThresholds {
  citationIntegrity: number;
  citationPrecision: number;
  supportedClaimRate: number;
  unsupportedCriticalClaimCount: number;
  evidenceCoverage: number;
  staleSourceDetection: number;
  conflictDetection: number;
  researchGapDetection: number;
  numericConsistency: number;
  unitConsistency: number;
  outOfScopeFindingCount: number;
  qaBlockerRecall: number;
  qaBlockerBypassCount: number;
  reportRequiredSectionCompletion: number;
  crossProjectEvidenceReferenceCount: number;
  promptInjectionPolicyBypassCount: number;
  pipelineStageCompletion: number;
  providerRequestCompleteness: number;
  boundaryCompliance: number;
  deterministicHashMismatchCount: number;
}

export interface EvalSummary {
  schemaVersion: "research-eval-v2";
  corpus: "synthetic-closed-corpus";
  executionMode: "durable-postgresql-orchestration";
  repetitionsPerFixture: 2;
  evaluatedRunCount: number;
  pipelineVersion: string;
  provider: string;
  model: string;
  promptVersion: string;
  startedAt: string;
  durationMs: number;
  accuracyScore: number;
  fixtureResults: readonly EvalFixtureMetrics[];
  metrics: Omit<
    EvalFixtureMetrics,
    | "fixtureId"
    | "primaryRunId"
    | "repeatRunId"
    | "outputHash"
    | "repeatOutputHash"
    | "reproducible"
    | "estimatedCostUsd"
  > & {
    estimatedCostUsd: number | null;
    deterministicHashMismatchCount: number;
  };
  thresholds: EvalThresholds;
  failures: readonly string[];
  passed: boolean;
  limitations: readonly string[];
}
