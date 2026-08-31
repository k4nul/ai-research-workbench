import { SessionManager } from "@/components/auth/session-manager";
import { PageShell } from "@/components/features/page-shell";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  await requirePageOperator();
  return (
    <PageShell
      description="Review active clients, revoke access, rotate your password, or sign out."
      eyebrow="Operator security"
      title="Sessions"
    >
      <SessionManager />
    </PageShell>
  );
}
