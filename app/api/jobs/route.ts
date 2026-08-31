import { z } from "zod";

import { JOB_STATUSES } from "@/lib/domain/jobs";
import { handleAuthenticatedRoute } from "@/lib/http";
import { operationIdSchema } from "@/lib/operations/request";
import { listJobs } from "@/lib/services/operations";

const querySchema = z
  .object({
    projectId: operationIdSchema.optional(),
    status: z.enum(JOB_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0)
  })
  .strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return listJobs(input);
  });
}
