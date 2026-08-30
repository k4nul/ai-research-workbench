import { PageShell } from "@/components/features/page-shell";
import { LoadingState } from "@/components/ui";

export default function Loading() {
  return <PageShell description="Retrieving the latest stored research state." title="Loading workspace"><LoadingState title="Loading workspace" /></PageShell>;
}
