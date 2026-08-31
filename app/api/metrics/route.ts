import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { getOperationalMetrics } from "@/lib/services/operational-metrics";

const querySchema = z
  .object({ staleAfterSeconds: z.coerce.number().int().min(5).max(3_600).default(30) })
  .strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const { staleAfterSeconds } = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    return getOperationalMetrics(staleAfterSeconds);
  });
}
