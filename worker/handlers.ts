import type { JobRow } from "@/lib/services/jobs";

export type JobHandlerContext = {
  job: JobRow;
  workerId: string;
  signal: AbortSignal;
};

export type JobHandler = (context: JobHandlerContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler): void {
  const normalized = jobType.trim();
  if (!normalized) {
    throw new Error("jobType must not be blank.");
  }
  if (handlers.has(normalized)) {
    throw new Error(`A handler is already registered for ${normalized}.`);
  }
  handlers.set(normalized, handler);
}

export function registeredJobHandlers(): ReadonlyMap<string, JobHandler> {
  return new Map(handlers);
}
