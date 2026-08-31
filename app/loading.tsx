import { PageShell } from "@/components/features/page-shell";
import { LoadingState } from "@/components/ui";

export default function Loading() {
  return (
    <PageShell
      description="Retrieving the latest stored research state."
      title="Loading workspace"
    >
      <noscript>
        <section className="state-panel state-panel--error" role="alert">
          <div>
            <h2>JavaScript required</h2>
            <p>JavaScript is required to use AI Research Workbench.</p>
          </div>
        </section>
      </noscript>
      <LoadingState title="Loading workspace" />
    </PageShell>
  );
}
