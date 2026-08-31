import { z } from "zod";

import { principalAuditActor } from "@/lib/auth/audit-actor";
import type { RequestPrincipal } from "@/lib/auth/dal";

export const operationIdSchema = z.string().trim().min(1).max(500);
export const projectMutationSchema = z.object({ projectId: operationIdSchema }).strict();
export const jobMutationScopeSchema = z
  .object({ projectId: operationIdSchema.nullable() })
  .strict();

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Use letters, numbers, dots, underscores, colons, or hyphens.");

export function requestIdempotencyKey(request: Request): string {
  return idempotencyKeySchema.parse(request.headers.get("idempotency-key"));
}

export function requestQueryScope(request: Request): string {
  return new URL(request.url).search;
}

export function principalActorLabel(principal: RequestPrincipal): string {
  return principalAuditActor(principal).actorLabel;
}
