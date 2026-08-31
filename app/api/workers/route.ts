import { z } from "zod";

import { handleAuthenticatedRoute } from "@/lib/http";
import { listWorkers } from "@/lib/services/workers";

const querySchema = z
  .object({ staleAfterSeconds: z.coerce.number().int().min(5).max(3_600).default(30) })
  .strict();

export async function GET(request: Request) {
  return handleAuthenticatedRoute(request, async () => {
    const { staleAfterSeconds } = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    const workers = await listWorkers(staleAfterSeconds);
    return workers.map(({ metadata, ...worker }) => {
      void metadata;
      return worker;
    });
  });
}
