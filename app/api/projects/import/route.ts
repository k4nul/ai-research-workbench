import { z } from "zod";
import { handleRoute } from "@/lib/http";
import { parseIntakeImport } from "@/lib/intake-import";
import { createProject } from "@/lib/services/projects";
import { intakeImportSchema } from "@/lib/validation";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const input = intakeImportSchema.parse(await request.json());
    try {
      const intake = parseIntakeImport(input.format, input.content);
      return createProject(intake);
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
