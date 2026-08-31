import type { RequestPrincipal } from "@/lib/auth/dal";
import type { AuditActor } from "@/lib/services/audit";

export function principalAuditActor(principal: RequestPrincipal): AuditActor {
  return principal.kind === "operator"
    ? {
        actorType: "USER",
        actorLabel: `${principal.session.operator.displayName} (${principal.session.operator.username})`
      }
    : { actorType: "USER", actorLabel: "Local demo operator" };
}
