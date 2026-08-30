import { redirect } from "next/navigation";

import { loadSource } from "@/components/features/server-data";

export const dynamic = "force-dynamic";

export default async function CanonicalSourceRedirect({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const { source } = await loadSource(sourceId);
  redirect(`/projects/${encodeURIComponent(source.project_id)}/sources/${encodeURIComponent(sourceId)}`);
}
