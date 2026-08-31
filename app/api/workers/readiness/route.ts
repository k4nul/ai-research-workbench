import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { operationIdSchema } from "@/lib/operations/request";
import { getWorkerReadiness } from "@/lib/services/workers";

const querySchema = z
  .object({
    workerId: operationIdSchema,
    staleAfterSeconds: z.coerce.number().int().min(5).max(3_600).default(30)
  })
  .strict();

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return getWorkerReadiness(input);
  });
}
