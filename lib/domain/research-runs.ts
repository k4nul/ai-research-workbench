export const RESEARCH_RUN_STATUSES = [
  "CREATED",
  "WAITING_FOR_PLAN_APPROVAL",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "CANCELLING",
  "CANCELLED",
  "FAILED",
  "QA_REQUIRED",
  "APPROVAL_REQUIRED",
  "COMPLETED",
  "BLOCKED"
] as const;

export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export const RUN_STAGE_STATUSES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
  "STALE"
] as const;

export type RunStageStatus = (typeof RUN_STAGE_STATUSES)[number];

const runTransitions: Readonly<Record<ResearchRunStatus, readonly ResearchRunStatus[]>> = {
  CREATED: ["WAITING_FOR_PLAN_APPROVAL", "QUEUED", "CANCELLED"],
  WAITING_FOR_PLAN_APPROVAL: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "PAUSED", "CANCELLING", "CANCELLED", "FAILED", "BLOCKED"],
  RUNNING: [
    "PAUSED",
    "CANCELLING",
    "CANCELLED",
    "FAILED",
    "QA_REQUIRED",
    "APPROVAL_REQUIRED",
    "COMPLETED",
    "BLOCKED"
  ],
  PAUSED: ["QUEUED", "CANCELLING", "CANCELLED"],
  CANCELLING: ["CANCELLED", "FAILED"],
  CANCELLED: ["QUEUED"],
  FAILED: ["QUEUED"],
  QA_REQUIRED: [
    "QUEUED",
    "RUNNING",
    "APPROVAL_REQUIRED",
    "CANCELLING",
    "CANCELLED",
    "BLOCKED"
  ],
  APPROVAL_REQUIRED: [
    "QUEUED",
    "RUNNING",
    "COMPLETED",
    "CANCELLING",
    "CANCELLED",
    "BLOCKED"
  ],
  COMPLETED: ["QUEUED"],
  BLOCKED: ["QUEUED", "CANCELLING", "CANCELLED", "FAILED"]
};

const stageTransitions: Readonly<Record<RunStageStatus, readonly RunStageStatus[]>> = {
  PENDING: ["QUEUED", "CANCELLED", "BLOCKED"],
  QUEUED: ["RUNNING", "FAILED", "CANCELLED", "BLOCKED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"],
  SUCCEEDED: ["STALE"],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: ["QUEUED"],
  BLOCKED: ["QUEUED", "CANCELLED"],
  STALE: ["QUEUED", "CANCELLED"]
};

export function canTransitionResearchRun(
  from: ResearchRunStatus,
  to: ResearchRunStatus
): boolean {
  return runTransitions[from].includes(to);
}

export function assertResearchRunTransition(
  from: ResearchRunStatus,
  to: ResearchRunStatus
): void {
  if (!canTransitionResearchRun(from, to)) {
    throw new Error(`Research run cannot transition from ${from} to ${to}.`);
  }
}

export function canTransitionRunStage(
  from: RunStageStatus,
  to: RunStageStatus
): boolean {
  return stageTransitions[from].includes(to);
}

export function assertRunStageTransition(
  from: RunStageStatus,
  to: RunStageStatus
): void {
  if (!canTransitionRunStage(from, to)) {
    throw new Error(`Run stage cannot transition from ${from} to ${to}.`);
  }
}
