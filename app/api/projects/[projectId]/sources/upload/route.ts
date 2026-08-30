import { enforceRateLimit, handleRoute } from "@/lib/http";
import { uploadAndRegisterSource } from "@/lib/services/ingestion";
import { AppError } from "@/lib/services/errors";

type Context = { params: Promise<{ projectId: string }> };

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  return handleRoute(async () => {
    enforceRateLimit(request, "source-upload", 10);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(400, "FILE_REQUIRED", "Choose a source file to upload.");
    }
    return uploadAndRegisterSource(projectId, file, {
      title: text(form, "title"),
      publisher: text(form, "publisher"),
      author: text(form, "author"),
      publishedAt: text(form, "publishedAt"),
      sourceType: text(form, "sourceType"),
      language: text(form, "language"),
      reliabilityGrade: text(form, "reliabilityGrade"),
      usageRestrictions: text(form, "usageRestrictions")
    });
  }, { status: 201 });
}
