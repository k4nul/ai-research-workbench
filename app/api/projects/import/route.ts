import { z } from "zod";
import { principalAuditActor } from "@/lib/auth/audit-actor";
import { handleAuthenticatedRoute } from "@/lib/http";
import { parseIntakeImport } from "@/lib/intake-import";
import { createProject } from "@/lib/services/projects";
import { intakeImportSchema } from "@/lib/validation";

export async function POST(request: Request) {
  return handleAuthenticatedRoute(request, async (principal) => {
    const input = intakeImportSchema.parse(await request.json());
    try {
      const intake = parseIntakeImport(input.format, input.content);
      return createProject(intake, principalAuditActor(principal));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new z.ZodError([
          {
            code: "custom",
            path: ["content"],
            message: "The imported JSON is invalid."
          }
        ]);
      }
      throw error;
    }
  }, { status: 201 });
}
