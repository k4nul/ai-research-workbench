import { redirect } from "next/navigation";

import { loadSource } from "@/components/features/server-data";
import { requirePageOperator } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function CanonicalSourceRedirect({ params }: { params: Promise<{ sourceId: string }> }) {
  await requirePageOperator();
  const { sourceId } = await params;
  const { source } = await loadSource(sourceId);
  redirect(`/projects/${encodeURIComponent(source.project_id)}/sources/${encodeURIComponent(sourceId)}`);
}
