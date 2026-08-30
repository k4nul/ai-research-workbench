"use client";

import { PageShell } from "@/components/features/page-shell";
import { ErrorState } from "@/components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageShell description="The requested view could not be rendered." title="Workspace error"><ErrorState description={error.message || "An unexpected error prevented this view from loading."} onRetry={reset} title="Unable to load this screen" /></PageShell>;
}
