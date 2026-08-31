import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export type AuditInput = {
  projectId?: string;
  actorType: "USER" | "AI" | "SYSTEM";
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeState?: unknown;
  afterState?: unknown;
};

export type AuditActor = Pick<AuditInput, "actorType" | "actorLabel">;

export const LOCAL_USER_AUDIT_ACTOR: AuditActor = Object.freeze({
  actorType: "USER",
  actorLabel: "Local user"
});

export const CONFIGURED_PROVIDER_AUDIT_ACTOR: AuditActor = Object.freeze({
  actorType: "AI",
  actorLabel: "Configured provider"
});

export async function writeAuditEvent(
  client: PoolClient,
  input: AuditInput
): Promise<void> {
  await client.query(
    "INSERT INTO audit_events (id, project_id, actor_type, actor_label, action, resource_type, resource_id, before_state, after_state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)",
    [
      randomUUID(),
      input.projectId ?? null,
      input.actorType,
      input.actorLabel,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.beforeState === undefined ? null : JSON.stringify(input.beforeState),
      input.afterState === undefined ? null : JSON.stringify(input.afterState)
    ]
  );
}
