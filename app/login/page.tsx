import { LoginForm } from "@/components/auth/login-form";
import { PageShell } from "@/components/features/page-shell";
import { safeRedirectPath } from "@/lib/auth/csrf";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <PageShell
      description="Authenticate as an operator before accessing research data or controls."
      eyebrow="Operator access"
      title="Sign in"
    >
      <section className="section-card">
        <LoginForm nextPath={safeRedirectPath(next)} />
      </section>
    </PageShell>
  );
}
