import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { getProviderOperationsStatus } from "@/lib/services/operations";

const querySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const { limit } = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    return getProviderOperationsStatus(limit);
  });
}
